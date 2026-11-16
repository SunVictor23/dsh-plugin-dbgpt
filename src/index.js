/**
 * dsh plugin that hands database questions to DB-GPT. While the row is
 * enabled it keeps a DB-GPT webserver running (unless `manage` is false) and
 * registers two tools: `dbgpt_list_databases` and `dbgpt_query`. The `/dbgpt`
 * command reports the server state and restarts it.
 */
import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { askDatabase, listDatabases, parseChatData } from './dbgpt-api.js'
import { DbgptConfigError, resolveLaunch } from './launch.js'
import { columnsOf, renderDatabases, renderQuery } from './render.js'
import { DbgptSupervisor } from './supervisor.js'

export const name = 'dbgpt'
export const inject = ['tools', 'subprocess', 'credentials']
export { Config }

/** @param {unknown} value @returns {string | undefined} a non-empty trimmed string. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Convert a failure into the tool error the model sees. Cancellation passes
 * through unchanged; a request deadline becomes a timeout message.
 * @param {unknown} error - the failure.
 * @param {AbortSignal} callSignal - the tool call's own cancellation.
 * @param {number} timeoutMs - request deadline.
 * @returns {unknown} the error to throw.
 */
function toolError(error, callSignal, timeoutMs) {
  if (callSignal.aborted) return error
  if (error instanceof HarnessError) return error
  if (error?.name === 'TimeoutError') {
    return new HarnessError(`DB-GPT 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果。`, 'DBGPT_TIMEOUT')
  }
  if (typeof error?.code === 'string' && error.code.startsWith('DBGPT_')) return new HarnessError(error.message, error.code)
  return error
}

/** Words for the server states `/dbgpt` reports. */
const STATE_WORDS = { running: '运行中', starting: '启动中', failed: '启动失败', exited: '已退出', stopped: '未启动' }

/**
 * Register the DB-GPT tools and keep the managed server in step with the configuration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated configuration (see {@link Config}).
 */
export function apply(ctx, config) {
  const supervisor = new DbgptSupervisor(ctx, {
    resolveLaunch: () => resolveLaunch(ctx, config),
    startupTimeoutMs: config.startupTimeoutMs,
  })
  /** DB-GPT conversation per dsh Session and database, so follow-up questions keep their context. */
  const conversations = new Map()

  const reconcile = () => {
    supervisor.ensureReady().catch((error) => { ctx.logger.warn(`DB-GPT is not running: ${error.message}`) })
  }
  ctx.effect(() => {
    if (config.manage) reconcile()
    return () => supervisor.dispose()
  }, 'dbgpt: managed server')
  ctx.on('loader/volatile-update', () => { if (config.manage) reconcile() })

  /**
   * Where requests go: the managed server once ready, or the configured endpoint.
   * @param {AbortSignal} signal - abandons the wait.
   * @returns {Promise<{ endpoint: string, model: string }>} endpoint and DB-GPT model name.
   */
  async function connection(signal) {
    if (config.manage) return await supervisor.ensureReady(signal)
    const endpoint = text(config.endpoint)
    const model = text(config.llmModel.get())
    if (endpoint === undefined) throw new DbgptConfigError('manage 为 false 时必须设置 endpoint（DB-GPT 服务地址）。')
    if (model === undefined) throw new DbgptConfigError('manage 为 false 时必须设置 llmModel（DB-GPT 中部署的模型名称）。')
    return { endpoint: endpoint.replace(/\/+$/, ''), model }
  }

  /**
   * Run one DB-GPT call with the request deadline and tool-error conversion.
   * @template T
   * @param {{ signal: AbortSignal }} exec - tool execution context.
   * @param {(endpoint: string, model: string, signal: AbortSignal) => Promise<T>} body - the calls to make.
   * @returns {Promise<T>} the body's result.
   */
  async function call(exec, body) {
    try {
      const { endpoint, model } = await connection(exec.signal)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.requestTimeoutMs)])
      return await body(endpoint, model, signal)
    } catch (error) {
      throw toolError(error, exec.signal, config.requestTimeoutMs)
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dbgpt_list_databases',
    description: 'List the databases connected to DB-GPT, the user\'s database question-answering service. '
      + 'Call it before dbgpt_query when you do not yet know which database holds the data a question needs.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderDatabases(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return await call(exec, async (endpoint, _model, signal) => ({ databases: await listDatabases(endpoint, signal) }))
    },
  })), 'dbgpt: dbgpt_list_databases')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dbgpt_query',
    description: 'Answer a question from the data in one DB-GPT database. DB-GPT reads the schema, writes and runs SQL, '
      + 'and returns its explanation, the SQL, and the result rows. Use it whenever the user wants data looked up, counted, '
      + 'aggregated, compared, ranked, or analyzed from these databases, instead of guessing or writing SQL yourself. '
      + 'Ask one self-contained question per call in the user\'s language, stating the metric, filters, grouping, and time range. '
      + 'Follow-up questions about the same database in this conversation may refer to earlier ones.',
    parameters: {
      database: { type: 'string', required: true, description: 'Database name exactly as dbgpt_list_databases reports it.' },
      question: { type: 'string', required: true, description: 'The data question, in natural language.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderQuery(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return await call(exec, async (endpoint, model, signal) => {
        const databases = await listDatabases(endpoint, signal)
        if (!databases.some(db => db.name === args.database)) {
          const names = databases.map(db => db.name).join('、') || '（无）'
          throw new HarnessError(`DB-GPT 中没有名为 ${args.database} 的数据库。现有数据库：${names}`, 'DBGPT_UNKNOWN_DATABASE')
        }
        const key = `${exec.agent?.session?.id ?? randomUUID()}\0${args.database}`
        if (!conversations.has(key)) conversations.set(key, randomUUID())
        const answer = parseChatData(await askDatabase(endpoint, {
          model, database: args.database, question: args.question, conversation: conversations.get(key),
        }, signal))
        const value = { database: args.database, summary: answer.summary }
        if (answer.sql !== undefined) value.sql = answer.sql
        if (answer.chartType !== undefined) value.chartType = answer.chartType
        if (answer.error !== undefined) value.error = answer.error
        if (answer.rows !== undefined) {
          value.rowCount = answer.rows.length
          value.columns = columnsOf(answer.rows)
          value.rows = answer.rows.slice(0, config.maxRows.get())
        }
        return value
      })
    },
  })), 'dbgpt: dbgpt_query')

  /** @returns {string} the `/dbgpt` status report. */
  function statusText() {
    if (!config.manage) return `DB-GPT 由外部管理，插件连接 ${text(config.endpoint) ?? '（未设置 endpoint）'}。`
    const { state, spec, error } = supervisor.status()
    const lines = [`DB-GPT：${STATE_WORDS[state] ?? state}`]
    if (spec !== undefined) {
      lines.push(
        `模型：${spec.model}（${spec.source === 'dsh' ? '复用 dsh 的 API' : '单独配置'}，${spec.baseURL}）`,
        `网页：http://${spec.bindHost === '0.0.0.0' ? '127.0.0.1' : spec.bindHost}:${spec.port}`,
        `目录：${spec.home}`,
      )
    }
    if (error !== undefined) lines.push(`原因：${error.message ?? String(error)}`)
    return lines.join('\n')
  }

  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: 'dbgpt',
      description: 'Show the DB-GPT server state, or restart it',
      input: { hint: '[status|restart]' },
      handler: async ({ rawInput }) => {
        const action = rawInput.trim()
        if (action === 'restart') {
          if (!config.manage) return { kind: 'error', text: 'DB-GPT 由外部管理，插件不能重启它。' }
          try { await supervisor.restart() }
          catch (_failed) { return { kind: 'error', text: statusText() } /* statusText reports the failure. */ }
          return { kind: 'success', text: statusText() }
        }
        if (action !== '' && action !== 'status') return { kind: 'error', text: '用法：/dbgpt [status|restart]' }
        return { kind: 'success', text: statusText() }
      },
    }), 'dbgpt: /dbgpt command')
  })
}
