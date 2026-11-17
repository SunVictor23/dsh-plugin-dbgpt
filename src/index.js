/**
 * dsh plugin that hands database questions to DB-GPT. While the row is
 * enabled it keeps a DB-GPT webserver running (unless `manage` is false) and
 * registers `dbgpt_list_databases` plus one question tool picked by `mode`:
 * `dbgpt_agent` hands the whole question to DB-GPT's ReAct data agent and ends
 * dsh's turn with its conclusion; `dbgpt_query` runs one DB-GPT query and lets
 * dsh reason over the rows. The `/dbgpt` command reports the server state and
 * restarts it.
 */
import { randomUUID } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { PUBLIC_BASE_URL } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import { askDatabase, listDatabases, parseChatData, runAgent } from './dbgpt-api.js'
import { DbgptConfigError, resolveLaunch } from './launch.js'
import { columnsOf, renderAgent, renderDatabases, renderQuery, stepOutput } from './render.js'
import { DbgptSupervisor } from './supervisor.js'

export const name = 'dbgpt'
export const inject = ['tools', 'subprocess']
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
/** Words for the question modes `/dbgpt` reports. */
const MODE_WORDS = { agent: 'ReAct 智能体（DB-GPT 思考，dsh 只转交问题）', sql: '单轮 SQL（dsh 根据查询结果思考）' }

/**
 * Endpoint of dsh's DeepSeek API-key route when its settings name none; that
 * route does not report a default endpoint in the provider directory.
 */
const ENDPOINT_DEFAULTS = { 'llm-deepseek': { env: ['DEEPSEEK_BASE_URL'], baseURL: PUBLIC_BASE_URL } }

/**
 * Register the DB-GPT tools and keep the managed server in step with the configuration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated configuration (see {@link Config}).
 */
export function apply(ctx, config) {
  const supervisor = new DbgptSupervisor(ctx, {
    resolveLaunch: () => resolveLaunch(ctx, config, ENDPOINT_DEFAULTS),
    startupTimeoutMs: config.startupTimeoutMs,
  })
  /** DB-GPT conversation per dsh Session and database, so follow-up questions keep their context. */
  const conversations = new Map()
  /** Settles when the last request queued on a conversation settles. */
  const conversationTails = new Map()

  /**
   * Run requests on one DB-GPT conversation one at a time: DB-GPT fails a
   * request that writes the conversation's history while another one does.
   * @template T
   * @param {string} id - DB-GPT conversation id.
   * @param {() => Promise<T>} task - the request.
   * @returns {Promise<T>} the request's result.
   */
  function inConversation(id, task) {
    const run = (conversationTails.get(id) ?? Promise.resolve()).then(task)
    const tail = run.then(() => undefined, () => undefined)
    conversationTails.set(id, tail)
    void tail.then(() => { if (conversationTails.get(id) === tail) conversationTails.delete(id) })
    return run
  }

  /** Start or restart the managed server when the configuration it depends on may have changed. */
  const reconcile = () => {
    if (!config.manage) return
    supervisor.ensureReady().catch((error) => { ctx.logger.warn(`DB-GPT is not running: ${error.message}`) })
  }
  ctx.effect(() => {
    reconcile()
    return () => supervisor.dispose()
  }, 'dbgpt: managed server')
  ctx.on('loader/volatile-update', reconcile)
  // Resolving the model reads the model provider, its settings, the default
  // model, and the credential store; these services can finish loading after
  // this plugin, so retry once each group is present and whenever the provider
  // directory changes. A retry against an unchanged configuration does nothing.
  ctx.inject(['llm', 'settings', 'agentDefaultModel'], (child) => { child.effect(() => { reconcile(); return () => {} }) })
  ctx.inject(['credentials'], (child) => { child.effect(() => { reconcile(); return () => {} }) })
  ctx.on('llm/adapters-updated', reconcile)

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
   * Run one DB-GPT call with a deadline and tool-error conversion.
   * @template T
   * @param {{ signal: AbortSignal }} exec - tool execution context.
   * @param {(endpoint: string, model: string, signal: AbortSignal) => Promise<T>} body - the calls to make.
   * @param {number} timeoutMs - deadline for the whole body.
   * @returns {Promise<T>} the body's result.
   */
  async function call(exec, body, timeoutMs = config.requestTimeoutMs) {
    try {
      const { endpoint, model } = await connection(exec.signal)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)])
      return await body(endpoint, model, signal)
    } catch (error) {
      throw toolError(error, exec.signal, timeoutMs)
    }
  }

  /**
   * DB-GPT conversation of one dsh Session, database, and mode, so follow-up
   * questions keep their context; the two modes keep separate conversations.
   * @param {{ agent?: { session?: { id: string } } }} exec - tool execution context.
   * @param {string} database - database name.
   * @param {string} mode - question mode.
   * @returns {string} the DB-GPT conversation id.
   */
  function conversationOf(exec, database, mode) {
    const key = `${mode}\0${exec.agent?.session?.id ?? randomUUID()}\0${database}`
    if (!conversations.has(key)) conversations.set(key, randomUUID())
    return conversations.get(key)
  }

  /**
   * Fail with the names DB-GPT has when `database` is not one of them.
   * @param {string} endpoint - DB-GPT base URL.
   * @param {string} database - the requested database.
   * @param {AbortSignal} signal - request bound.
   */
  async function checkDatabase(endpoint, database, signal) {
    const databases = await listDatabases(endpoint, signal)
    if (!databases.some(db => db.name === database)) {
      const names = databases.map(db => db.name).join('、') || '（无）'
      throw new HarnessError(`DB-GPT 中没有名为 ${database} 的数据库。现有数据库：${names}`, 'DBGPT_UNKNOWN_DATABASE')
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dbgpt_list_databases',
    description: 'List the databases connected to DB-GPT, the user\'s database question-answering service. '
      + 'Call it first when you do not yet know which database holds the data a question needs.',
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

  // Both question tools stay registered; each step offers the model the one `mode` selects.
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
        await checkDatabase(endpoint, args.database, signal)
        const conversation = conversationOf(exec, args.database, 'sql')
        const answer = parseChatData(await inConversation(conversation, () => askDatabase(endpoint, {
          model, database: args.database, question: args.question, conversation,
        }, signal)))
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
  }), { when: () => config.mode.get() === 'sql' }), 'dbgpt: dbgpt_query')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dbgpt_agent',
    description: 'Hand a data question to DB-GPT\'s data agent, which owns the whole analysis: it reads the schema of one database, '
      + 'plans, runs SQL, draws charts, retries failed queries on its own, and writes the conclusion. Use it whenever the user wants '
      + 'data looked up, counted, aggregated, compared, ranked, or analyzed from these databases, instead of guessing or writing SQL yourself. '
      + 'Pass the user\'s request as they wrote it, in their language, in one call: do not split it, rewrite it, explore the data first, '
      + 'or retry with other wording. The conclusion is shown to the user as it is and ends your turn, so there is nothing to add after it. '
      + 'Follow-up questions about the same database in this conversation continue DB-GPT\'s context. If the call fails, tell the user '
      + 'what DB-GPT reported instead of answering from your own knowledge.',
    parameters: {
      database: { type: 'string', required: true, description: 'Database name exactly as dbgpt_list_databases reports it.' },
      question: { type: 'string', required: true, description: 'The user\'s data question, as they asked it.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderAgent(value) }],
      // The conversation view draws the conclusion and the steps from this.
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = await call(exec, async (endpoint, model, signal) => {
        await checkDatabase(endpoint, args.database, signal)
        const conversation = conversationOf(exec, args.database, 'agent')
        const run = await inConversation(conversation, () => runAgent(endpoint, {
          model, database: args.database, question: args.question, conversation, language: config.language.get(),
        }, signal))
        return {
          database: args.database,
          final: run.final,
          plan: run.plan,
          steps: run.steps.map((step) => {
            const shown = { title: step.intention || step.title || step.action || '', status: step.status, output: stepOutput(step.outputs, step.input) }
            if (step.action !== undefined) shown.action = step.action
            if (step.thought !== undefined) shown.thought = step.thought
            return shown
          }),
        }
      }, config.agentTimeoutMs)
      // DB-GPT's conclusion is the answer: dsh shows it and does not think it over again.
      exec.concludeTurn()
      return value
    },
  }), { when: () => config.mode.get() === 'agent' }), 'dbgpt: dbgpt_agent')

  /** @returns {string} the `/dbgpt` status report. */
  function statusText() {
    const mode = `分析方式：${MODE_WORDS[config.mode.get()] ?? config.mode.get()}`
    if (!config.manage) return `DB-GPT 由外部管理，插件连接 ${text(config.endpoint) ?? '（未设置 endpoint）'}。\n${mode}`
    const { state, spec, error } = supervisor.status()
    const lines = [`DB-GPT：${STATE_WORDS[state] ?? state}`, mode]
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
