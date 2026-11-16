/**
 * Owns the managed DB-GPT webserver: starts it from a resolved launch
 * specification, waits until its API answers, restarts it when the
 * specification changes, and stops it when the plugin unloads. Operations run
 * one at a time.
 */
import { access, constants, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { connect } from 'node:net'
import { DbgptConfigError, EMBEDDING_KEY_ENV, LLM_KEY_ENV, renderToml, sameLaunch, tomlPath } from './launch.js'

/** Bytes of each output stream kept for failure reports. */
const OUTPUT_TAIL_BYTES = 64 * 1024
/** Lines of output quoted in a failure report. */
const REPORT_LINES = 30
/** Interval between readiness probes. */
const PROBE_INTERVAL_MS = 1000
/** Grace period between SIGTERM and SIGKILL when the server is stopped. */
const GRACE_MS = 10_000

/** A failure of the DB-GPT server itself; the message is user-facing Chinese. */
export class DbgptServerError extends Error {
  /** @param {string} message - what failed. */
  constructor(message) {
    super(message)
    this.name = 'DbgptServerError'
    this.code = 'DBGPT_SERVER'
  }
}

/** @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

/**
 * Whether something accepts TCP connections on the loopback port.
 * @param {number} port - port to probe.
 * @returns {Promise<boolean>} true when the port is taken.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { resolve(false) })
  })
}

/**
 * Process ids whose command line contains the marker. Linux exposes command
 * lines under /proc; elsewhere nothing is found and a leftover server shows up
 * as a busy port instead.
 * @param {string} marker - substring to look for.
 * @returns {Promise<number[]>} matching process ids.
 */
async function processesNaming(marker) {
  let entries
  try { entries = await readdir('/proc') }
  catch (_noProcfs) { return [] /* Not Linux: rely on the port check. */ }
  const found = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    let cmdline
    try { cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8') }
    catch (_gone) { continue /* The process exited while being listed. */ }
    if (cmdline.split('\0').includes(marker)) found.push(Number(entry))
  }
  return found
}

/**
 * Stop servers an earlier dsh process started with the same generated TOML and
 * did not stop, such as after a crash.
 * @param {string} marker - the generated TOML path.
 * @returns {Promise<number>} how many processes were stopped.
 */
async function stopLeftovers(marker) {
  const pids = await processesNaming(marker)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') }
    catch (_gone) { /* Already exited. */ }
  }
  const deadline = Date.now() + GRACE_MS
  for (const pid of pids) {
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) }
      catch (_gone) { break /* Exited. */ }
      await sleep(200)
    }
    try { process.kill(pid, 'SIGKILL') }
    catch (_gone) { /* Exited within the grace period. */ }
  }
  return pids.length
}

/**
 * Last lines of a collected stream.
 * @param {{ readFrom(offset: number): { text: string } } | undefined} reader - collect-mode reader.
 * @returns {string} trailing lines, or an empty string.
 */
function tail(reader) {
  if (reader === undefined) return ''
  return reader.readFrom(0).text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n').slice(-REPORT_LINES).join('\n')
}

export class DbgptSupervisor {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context providing `subprocess` and `logger`.
   * @param {object} options - supervisor options.
   * @param {() => Promise<object>} options.resolveLaunch - resolves the current launch specification.
   * @param {number} options.startupTimeoutMs - startup deadline.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    /** @type {null | { spec: object, handle: object, ready: Promise<void>, exited: boolean, failed: boolean }} */
    this.current = null
    this.queue = Promise.resolve()
    this.disposed = false
    this.lastError = undefined
  }

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} the task result, after earlier tasks settle. */
  serial(task) {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Make sure a server matching the current configuration is running and ready.
   * @param {AbortSignal} [signal] - abandons the wait, not the start.
   * @returns {Promise<{ endpoint: string, model: string }>} where to send requests.
   */
  async ensureReady(signal) {
    const current = await this.serial(async () => {
      if (this.disposed) throw new DbgptServerError('DB-GPT 插件已停用。')
      let spec
      try { spec = await this.options.resolveLaunch() }
      catch (error) { this.lastError = error; throw error }
      if (this.current !== null && !this.current.exited && !this.current.failed && sameLaunch(this.current.spec, spec)) {
        return this.current
      }
      await this.stopCurrent()
      return await this.start(spec)
    })
    await (signal === undefined ? current.ready : Promise.race([
      current.ready,
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ]))
    return { endpoint: `http://127.0.0.1:${current.spec.port}`, model: current.spec.model }
  }

  /**
   * Stop the server and start it again with the current configuration.
   * @returns {Promise<{ endpoint: string, model: string }>} the restarted server.
   */
  async restart() {
    await this.serial(() => this.stopCurrent())
    return await this.ensureReady()
  }

  /**
   * Describe the server for the status command.
   * @returns {{ state: string, spec?: object, error?: unknown }} current state; the spec excludes the API keys.
   */
  status() {
    const current = this.current
    if (current === null) return { state: this.lastError === undefined ? 'stopped' : 'failed', error: this.lastError }
    const { apiKey: _key, embeddingApiKey: _embeddingKey, ...spec } = current.spec
    if (current.failed) return { state: 'failed', spec, error: this.lastError }
    if (current.exited) return { state: 'exited', spec }
    return { state: current.readySettled ? 'running' : 'starting', spec }
  }

  /**
   * Start one server.
   * @param {object} spec - launch specification.
   * @returns {Promise<object>} the running entry; its `ready` settles when the API answers.
   */
  async start(spec) {
    try { await access(spec.argv[0], constants.X_OK) }
    catch (_missing) {
      throw this.fail(new DbgptConfigError(`找不到 DB-GPT 启动程序 ${spec.argv[0]}。请检查 DB-GPT 目录，并确认已在其中执行过 uv sync 安装依赖。`))
    }
    const marker = tomlPath(spec.port)
    await mkdir(dirname(marker), { recursive: true })
    await writeFile(marker, renderToml(spec), { mode: 0o600 })
    const leftovers = await stopLeftovers(marker)
    if (leftovers > 0) this.ctx.logger.info(`stopped ${leftovers} DB-GPT process(es) left over from an earlier run`)
    if (await portInUse(spec.port)) {
      throw this.fail(new DbgptServerError(`端口 ${spec.port} 已被其他程序占用（可能是手动启动的 DB-GPT）。请先停止它，或在 DB-GPT 插件设置里换一个端口。`))
    }
    this.ctx.logger.info(`starting DB-GPT on port ${spec.port} with model ${spec.model} (${spec.source})`)
    const handle = this.ctx.subprocess.spawn({
      argv: spec.argv,
      cwd: spec.home,
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_TAIL_BYTES }, stderr: { maxBytes: OUTPUT_TAIL_BYTES } },
      graceMs: GRACE_MS,
      env: { [LLM_KEY_ENV]: spec.apiKey, [EMBEDDING_KEY_ENV]: spec.embeddingApiKey, PYTHONUNBUFFERED: '1' },
    })
    const entry = { spec, handle, exited: false, failed: false, readySettled: false, ready: undefined }
    const exit = handle.done.then(
      outcome => ({ outcome }),
      error => ({ error }),
    ).then((result) => {
      entry.exited = true
      return result
    })
    entry.ready = this.waitUntilReady(entry, exit).then(
      () => { entry.readySettled = true; this.lastError = undefined },
      (error) => { entry.failed = true; this.lastError = error; handle.terminate(); throw error },
    )
    // A start nobody waits for (plugin load, settings change) still reports its failure in the log.
    entry.ready.catch((error) => { this.ctx.logger.warn(`DB-GPT failed to start: ${error.message}`) })
    this.current = entry
    return entry
  }

  /**
   * Poll the API until it answers, the process exits, or the deadline passes.
   * @param {object} entry - the starting server.
   * @param {Promise<object>} exit - settles when the process exits.
   * @returns {Promise<void>} resolves once the server is ready.
   */
  async waitUntilReady(entry, exit) {
    const url = `http://127.0.0.1:${entry.spec.port}/api/v2/serve/datasources`
    const deadline = Date.now() + this.options.startupTimeoutMs
    const exited = exit.then(result => ({ exited: result }))
    while (Date.now() < deadline) {
      const probe = fetch(url, { signal: AbortSignal.timeout(3000) }).then(
        response => ({ ok: response.ok }),
        () => ({ ok: false }),
      )
      const result = await Promise.race([probe, exited])
      if ('exited' in result) {
        const { outcome, error } = result.exited
        const reason = error !== undefined ? String(error.message ?? error) : `退出码 ${outcome.exitCode ?? outcome.signal}`
        const output = [tail(entry.handle.collected.stderr), tail(entry.handle.collected.stdout)].filter(Boolean).join('\n')
        throw new DbgptServerError(`DB-GPT 启动失败（${reason}）。${output === '' ? '' : `最后的输出：\n${output}`}`)
      }
      if (result.ok) return
      await Promise.race([sleep(PROBE_INTERVAL_MS), exited])
    }
    throw new DbgptServerError(`DB-GPT 在 ${Math.round(this.options.startupTimeoutMs / 1000)} 秒内没有启动完成。日志在 ${entry.spec.home}/logs/。`)
  }

  /** @param {Error} error @returns {Error} the error, recorded as the last failure. */
  fail(error) {
    this.lastError = error
    return error
  }

  /** Stop the current server, if any, and wait until it has exited. */
  async stopCurrent() {
    const current = this.current
    if (current === null) return
    this.current = null
    current.handle.terminate()
    try { await current.handle.waitForExit() }
    catch (error) { this.ctx.logger.warn(`cannot confirm DB-GPT exited: ${error.message}`) }
  }

  /** Stop the server for good; later calls fail. */
  async dispose() {
    this.disposed = true
    await this.serial(() => this.stopCurrent())
  }
}
