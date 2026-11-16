/** HTTP calls to the DB-GPT webserver and parsing of its chat-data answers. */

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
