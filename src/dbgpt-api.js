/** HTTP calls to the DB-GPT webserver: chat-data answers and data-agent runs. */

/** A DB-GPT request that failed; the message is user-facing Chinese. */
export class DbgptRequestError extends Error {
  /** @param {string} message - what failed. */
  constructor(message) {
    super(message)
    this.name = 'DbgptRequestError'
    this.code = 'DBGPT_REQUEST'
  }
}

/**
 * Send one JSON request.
 * @param {string} url - request URL.
 * @param {RequestInit} init - fetch options; `signal` bounds the request.
 * @returns {Promise<any>} the parsed JSON body.
 */
async function requestJson(url, init) {
  let response
  try { response = await fetch(url, init) }
  catch (error) {
    if (init.signal?.aborted) throw init.signal.reason
    throw new DbgptRequestError(`无法连接 DB-GPT（${url}）：${error.cause?.message ?? error.message}`)
  }
  const body = await response.text()
  if (!response.ok) throw new DbgptRequestError(`DB-GPT 返回 HTTP ${response.status}：${body.slice(0, 500)}`)
  try { return JSON.parse(body) }
  catch (_notJson) { throw new DbgptRequestError(`DB-GPT 返回了无法解析的内容：${body.slice(0, 500)}`) }
}

/**
 * List the datasources configured in DB-GPT.
 * @param {string} endpoint - DB-GPT base URL.
 * @param {AbortSignal} signal - request bound.
 * @returns {Promise<{ name: string, type: string, description: string }[]>} the databases.
 */
export async function listDatabases(endpoint, signal) {
  const body = await requestJson(`${endpoint}/api/v2/serve/datasources`, { signal })
  if (body.success !== true || !Array.isArray(body.data)) {
    throw new DbgptRequestError(`读取 DB-GPT 数据源失败：${body.err_msg ?? JSON.stringify(body).slice(0, 300)}`)
  }
  return body.data.map(item => ({
    name: String(item.db_name),
    type: String(item.type ?? item.db_type ?? ''),
    description: String(item.description ?? item.comment ?? ''),
  }))
}

/**
 * Ask DB-GPT one question in chat-data mode: it writes SQL for the database,
 * runs it, and answers with its explanation and the result rows.
 * @param {string} endpoint - DB-GPT base URL.
 * @param {{ model: string, database: string, question: string, conversation: string }} request - the question and its target.
 * @param {AbortSignal} signal - request bound.
 * @returns {Promise<string>} the raw answer text.
 */
export async function askDatabase(endpoint, request, signal) {
  const body = await requestJson(`${endpoint}/api/v2/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      chat_mode: 'chat_data',
      chat_param: request.database,
      conv_uid: request.conversation,
      messages: request.question,
      stream: false,
    }),
    signal,
  })
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new DbgptRequestError(`DB-GPT 没有返回回答：${JSON.stringify(body).slice(0, 500)}`)
  }
  return content
}

/** XML character references DB-GPT leaves in the chart-view attribute. */
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&amp;': '&' }

/** @param {string} value @returns {string} the attribute text with character references decoded. */
function decodeAttribute(value) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(lt|gt|quot|apos|amp);/g, match => ENTITIES[match])
}

/** @param {string} value @returns {string} text without HTML tags, literal `\n` markers, and surrounding space. */
function plainText(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Split a chat-data answer into DB-GPT's explanation and its query result. The
 * result travels in a `<chart-view content="…" />` element whose attribute is
 * JSON with `type` (the suggested chart), `sql`, and `data` rows; a failed
 * query is marked by an `ERROR!` span before it.
 * @param {string} content - answer text from {@link askDatabase}.
 * @returns {{ summary: string, sql?: string, chartType?: string, rows?: Record<string, unknown>[], error?: string }} the parts.
 */
export function parseChatData(content) {
  const start = content.indexOf('<chart-view')
  const failed = content.includes('ERROR!')
  if (start < 0) {
    const summary = plainText(content)
    return failed ? { summary: '', error: summary } : { summary }
  }
  const before = content.slice(0, start)
  const opening = content.indexOf('content="', start)
  const closing = Math.max(content.lastIndexOf('" />'), content.lastIndexOf('"/>'))
  let view
  if (opening >= 0 && closing > opening) {
    try { view = JSON.parse(decodeAttribute(content.slice(opening + 'content="'.length, closing))) }
    catch (_malformed) { view = undefined /* Reported below as an unreadable result. */ }
  }
  const result = {}
  if (failed) {
    const [explanation, ...reason] = before.split('ERROR!')
    result.summary = plainText(explanation)
    result.error = plainText(reason.join('ERROR!')) || 'DB-GPT 执行查询失败。'
  } else {
    result.summary = plainText(before)
  }
  if (view === undefined || typeof view !== 'object') {
    result.error ??= 'DB-GPT 返回的查询结果无法解析。'
    return result
  }
  if (typeof view.sql === 'string' && view.sql.trim() !== '') result.sql = view.sql.trim()
  if (typeof view.type === 'string') result.chartType = view.type
  if (Array.isArray(view.data)) result.rows = view.data
  return result
}

/** @param {unknown} value @returns {string | undefined} a non-empty trimmed string. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Split a server-sent event stream into events. Each event's `data:` lines are
 * joined and parsed as JSON; a payload that is not a JSON object with a `type`
 * becomes `{ type: 'message', content }`.
 */
export class EventStreamParser {
  constructor() {
    this.buffer = ''
    this.data = []
  }

  /** @param {string} text - the next decoded piece of the stream. @returns {object[]} events it completed. */
  push(text) {
    this.buffer += text
    const events = []
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, newline).replace(/\r$/, ''), events)
      this.buffer = this.buffer.slice(newline + 1)
    }
    return events
  }

  /** @returns {object[]} the events left when the stream ends. */
  end() {
    const events = []
    if (this.buffer !== '') this.line(this.buffer, events)
    this.buffer = ''
    this.line('', events)
    return events
  }

  /** @param {string} line - one line without its terminator. @param {object[]} events - completed events. */
  line(line, events) {
    if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''))
      return
    }
    if (line !== '' || this.data.length === 0) return
    const payload = this.data.join('\n')
    this.data = []
    let event
    try { event = JSON.parse(payload) }
    catch (_notJson) { event = undefined /* DB-GPT's plain-text fallback, kept as a message below. */ }
    events.push(event !== null && typeof event === 'object' && typeof event.type === 'string' ? event : { type: 'message', content: payload })
  }
}

/** Openings of the final answer DB-GPT sends when the agent run broke instead of concluding. */
const AGENT_FAILURES = ['React agent failed', '抱歉，回答生成过程中发生错误']

/**
 * Step fields `step.meta` fills, by event key. `action_input` holds the tool
 * calls' arguments; DB-GPT fills it in when a round runs several tools at once.
 */
const STEP_META_FIELDS = [['title', 'title'], ['thought', 'thought'], ['intention', 'action_intention'], ['action', 'action'], ['input', 'action_input']]

/**
 * The data agent's plan, steps, and conclusion, folded from its stream events.
 * DB-GPT splits plain text into 800-character `step.chunk` pieces and sends
 * Markdown and code whole, so consecutive text pieces are joined and every
 * other chunk is an output of its own. Not steps of their own: the closing
 * `terminate` round, the `todowrite` rounds whose task list `plan.update`
 * carries, and "thinking" placeholders a later round replaced before they
 * showed anything.
 */
export class AgentRun {
  constructor() {
    /** @type {Map<string, { title: string, thought?: string, intention?: string, action?: string, input?: string, status: string, outputs: { type: string, content: string }[] }>} */
    this.steps = new Map()
    /** @type {{ content: string, status: string }[]} */
    this.plan = []
    /** @type {string | undefined} */
    this.final = undefined
    /** Plain-text messages DB-GPT sent outside its event protocol. */
    this.messages = []
  }

  /** @param {string} id - step id. @returns the step, created on first sight. */
  step(id) {
    const key = String(id)
    if (!this.steps.has(key)) this.steps.set(key, { title: '', status: 'running', outputs: [] })
    return this.steps.get(key)
  }

  /** @param {Record<string, any>} event - one stream event. */
  apply(event) {
    switch (event.type) {
      case 'step.start': {
        const step = this.step(event.id)
        step.title = nonEmpty(event.title) ?? step.title
        break
      }
      case 'step.meta': {
        const step = this.step(event.id)
        for (const [field, key] of STEP_META_FIELDS) {
          const value = nonEmpty(event[key])
          if (value !== undefined) step[field] = value
        }
        break
      }
      case 'step.chunk': {
        const outputs = this.step(event.id).outputs
        const type = nonEmpty(event.output_type) ?? 'text'
        const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? null, null, 2)
        const last = outputs.at(-1)
        if (type === 'text' && last?.type === 'text') last.content += content
        else outputs.push({ type, content })
        break
      }
      case 'step.done':
        this.step(event.id).status = event.status === 'failed' ? 'failed' : 'done'
        break
      case 'plan.update':
        if (Array.isArray(event.tasks)) {
          this.plan = event.tasks
            .map(task => ({ content: nonEmpty(task?.content) ?? '', status: nonEmpty(task?.status) ?? 'pending' }))
            .filter(task => task.content !== '')
        }
        break
      case 'final':
        this.final = typeof event.content === 'string' ? event.content : ''
        break
      case 'message':
        if (nonEmpty(event.content) !== undefined) this.messages.push(event.content.trim())
        break
      default:
        break
    }
  }

  /** @param {string} content - a remark the plugin adds to the latest step. */
  note(content) {
    const latest = [...this.steps.values()].at(-1) ?? this.step('plugin-note')
    latest.outputs.push({ type: 'text', content })
  }

  /** @returns {{ final?: string, failed: boolean, plan: object[], steps: object[] }} the conclusion, the plan, and the steps that ran. */
  result() {
    const steps = [...this.steps.values()].filter(step => step.action !== 'terminate' && step.action !== 'todowrite'
      && (step.action !== undefined || step.thought !== undefined || step.outputs.length > 0))
    const final = this.final?.trim()
    return { final, failed: final !== undefined && AGENT_FAILURES.some(opening => final.startsWith(opening)), plan: this.plan, steps }
  }
}

/**
 * Dismiss a question the agent asked the user, so it carries on with its own
 * reading of the request instead of waiting for an answer.
 * @param {string} endpoint - DB-GPT base URL.
 * @param {AgentRun} run - the run the question belongs to; it records the question.
 * @param {Record<string, any>} event - the `question.asked` event.
 * @param {AbortSignal} signal - request bound.
 */
async function dismissQuestion(endpoint, run, event, signal) {
  const asked = (Array.isArray(event.questions) ? event.questions : [])
    .map(item => nonEmpty(item?.question) ?? nonEmpty(item?.header))
    .filter(question => question !== undefined)
  run.note(`DB-GPT 想向你确认：${asked.join('；') || '（未给出问题）'}。插件已跳过这个问题，DB-GPT 按自己的理解继续。`)
  try {
    await fetch(`${endpoint}/api/v1/chat/question/${encodeURIComponent(String(event.request_id))}/reject`, { method: 'POST', signal })
  } catch (_unreachable) {
    // DB-GPT stops waiting for an answer by itself after 300 seconds.
  }
}

/**
 * Hand one question about a database to DB-GPT's ReAct data agent and wait for
 * its conclusion. The agent plans, runs SQL, draws charts, and retries on its
 * own; this reads its event stream to the end.
 * @param {string} endpoint - DB-GPT base URL.
 * @param {{ model: string, database: string, question: string, conversation: string, language: string }} request - the question and its target.
 * @param {AbortSignal} signal - request bound.
 * @returns {Promise<{ final: string, plan: object[], steps: object[] }>} the conclusion, the plan, and the steps that led to it.
 */
export async function runAgent(endpoint, request, signal) {
  let response
  try {
    response = await fetch(`${endpoint}/api/v1/chat/react-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        conv_uid: request.conversation,
        chat_mode: 'chat_react_agent',
        model_name: request.model,
        // DB-GPT's own page names the database this way; the agent reads it as a hint.
        user_input: `[Database: ${request.database}] ${request.question}`,
        temperature: 0.6,
        max_new_tokens: 8000,
        select_param: '',
        ext_info: { locale: request.language, database_name: request.database },
      }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new DbgptRequestError(`无法连接 DB-GPT（${endpoint}）：${error.cause?.message ?? error.message}`)
  }
  if (!response.ok) throw new DbgptRequestError(`DB-GPT 返回 HTTP ${response.status}：${(await response.text()).slice(0, 500)}`)

  const run = new AgentRun()
  const parser = new EventStreamParser()
  const decoder = new TextDecoder()
  const handle = async (events) => {
    for (const event of events) {
      if (event.type === 'question.asked') await dismissQuestion(endpoint, run, event, signal)
      else run.apply(event)
    }
  }
  try {
    for await (const chunk of response.body) await handle(parser.push(decoder.decode(chunk, { stream: true })))
    await handle(parser.push(decoder.decode()))
    await handle(parser.end())
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new DbgptRequestError(`DB-GPT 智能体的输出中断了：${error.cause?.message ?? error.message}`)
  }

  const { final, failed, plan, steps } = run.result()
  if (final === undefined) {
    throw new DbgptRequestError(run.messages.join('\n') || 'DB-GPT 智能体没有给出结论就结束了。')
  }
  if (failed) throw new DbgptRequestError(`DB-GPT 智能体运行失败：${final}`)
  return { final, plan, steps }
}
