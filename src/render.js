/** Markdown for DB-GPT tool results: what the model reads and the steps the conversation view shows. */

/** Chart types DB-GPT suggests, as plain words. */
const CHART_NAMES = {
  response_table: 'table',
  response_bar_chart: 'bar chart',
  response_line_chart: 'line chart',
  response_pie_chart: 'pie chart',
  response_scatter_chart: 'scatter chart',
  response_area_chart: 'area chart',
  response_heatmap: 'heatmap',
  response_donut_chart: 'donut chart',
}

/** @param {unknown} value @returns {string} one Markdown table cell. */
function cell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Column names in first-seen order across the rows.
 * @param {Record<string, unknown>[]} rows - result rows.
 * @returns {string[]} column names.
 */
export function columnsOf(rows) {
  const columns = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }
  return columns
}

/**
 * Render rows as a Markdown table.
 * @param {string[]} columns - column order.
 * @param {Record<string, unknown>[]} rows - rows to render.
 * @returns {string} the table.
 */
function table(columns, rows) {
  const lines = [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${columns.map(column => cell(row[column])).join(' | ')} |`)
  return lines.join('\n')
}

/**
 * Render the canonical value of `dbgpt_query`.
 * @param {object} value - query result: database, summary, sql, chartType, columns, rows, rowCount, error.
 * @returns {string} Markdown for the model.
 */
export function renderQuery(value) {
  const parts = [`Database: ${value.database}`]
  if (value.summary) parts.push(value.summary)
  if (value.sql) parts.push(`SQL:\n\`\`\`sql\n${value.sql}\n\`\`\``)
  if (value.error) parts.push(`Query failed: ${value.error}`)
  if (value.rowCount !== undefined) {
    if (value.rowCount === 0) {
      parts.push('Result: no rows.')
    } else {
      const shown = value.rows.length < value.rowCount ? `, first ${value.rows.length} shown` : ''
      parts.push(`Result: ${value.rowCount} row(s)${shown}.\n\n${table(value.columns, value.rows)}`)
    }
  }
  // DB-GPT names a plain table either `response_table` or `Table`.
  if (value.chartType && !/table/i.test(value.chartType) && value.rowCount) {
    parts.push(`DB-GPT suggests showing this as a ${CHART_NAMES[value.chartType] ?? value.chartType}.`)
  }
  return parts.join('\n\n')
}

/**
 * Render the canonical value of `dbgpt_list_databases`.
 * @param {{ databases: { name: string, type: string, description: string }[] }} value - the list.
 * @returns {string} Markdown for the model.
 */
export function renderDatabases(value) {
  if (value.databases.length === 0) {
    return 'DB-GPT has no databases connected. The user adds them on the DB-GPT web page (Data sources).'
  }
  const lines = value.databases.map(db => `- ${db.name} (${db.type})${db.description ? `: ${db.description}` : ''}`)
  return `Databases connected in DB-GPT:\n${lines.join('\n')}`
}

/** Chart types as the step view names them. */
const CHART_WORDS = {
  response_table: '表格',
  response_bar_chart: '柱状图',
  response_line_chart: '折线图',
  response_pie_chart: '饼图',
  response_donut_chart: '环形图',
  response_scatter_chart: '散点图',
  response_bubble_chart: '气泡图',
  response_area_chart: '面积图',
  response_heatmap: '热力图',
  response_heatmap_chart: '热力图',
}

/** Most rows of one chart's data the step view shows. */
const CHART_ROWS = 50
/** Most characters of one step's output kept for the view. */
const STEP_OUTPUT_LIMIT = 20_000

/** @param {string} text - text to cut. @param {number} limit - most characters kept. @returns {string} the text, marked when cut. */
function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n\n…（已截断，共 ${text.length} 字）` : text
}

/** @param {string} body - code to fence. @param {string} [lang] - fence language. @returns {string} a fence no line of the body closes. */
function fence(body, lang = '') {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map(match => match[0].length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

/**
 * Replace the `vis-db-chart` fences DB-GPT's chart tool writes with the SQL and
 * the data they carry; the conversation view cannot draw DB-GPT's charts.
 * @param {string} markdown - one Markdown output.
 * @returns {string} the output with readable charts.
 */
export function readableCharts(markdown) {
  return markdown.replace(/```vis-db-chart[^\n]*\n([\s\S]*?)\n```/g, (whole, json) => {
    let chart
    try { chart = JSON.parse(json) }
    catch (_malformed) { return whole }
    const parts = [`**图表：${CHART_WORDS[chart.type] ?? chart.type ?? '图表'}**${chart.title ? ` ${chart.title}` : ''}`]
    if (typeof chart.sql === 'string' && chart.sql.trim() !== '') parts.push(fence(chart.sql.trim(), 'sql'))
    const rows = Array.isArray(chart.data) ? chart.data.filter(row => row !== null && typeof row === 'object') : []
    if (rows.length > 0) {
      const shown = rows.slice(0, CHART_ROWS)
      parts.push(table(columnsOf(shown), shown))
      if (rows.length > shown.length) parts.push(`共 ${rows.length} 行，只显示前 ${shown.length} 行。`)
    }
    return parts.join('\n\n')
  })
}

/** @param {string} text - possibly JSON. @returns {unknown} the parsed value, or undefined when it is not JSON. */
function parseJson(text) {
  try { return JSON.parse(text) }
  catch (_notJson) { return undefined }
}

/** @param {unknown} call - one tool call's arguments. @returns {string | undefined} its SQL as a fence. */
function sqlOf(call) {
  return call !== null && typeof call === 'object' && typeof call.sql === 'string' && call.sql.trim() !== ''
    ? fence(call.sql.trim(), 'sql')
    : undefined
}

/**
 * The outputs inside one tool result: its `{ chunks: [{ output_type, content }] }`
 * JSON when it is that, the text itself otherwise.
 * @param {unknown} content - a tool result's content.
 * @returns {{ type: string, content: string }[]} the outputs.
 */
function chunksOf(content) {
  const parsed = typeof content === 'string' ? parseJson(content) : content
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.chunks)) {
    return parsed.chunks.filter(chunk => chunk !== null && typeof chunk === 'object').map(chunk => ({
      type: typeof chunk.output_type === 'string' ? chunk.output_type : 'text',
      content: typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content ?? null, null, 2),
    }))
  }
  return [{ type: 'text', content: typeof content === 'string' ? content : JSON.stringify(content ?? null, null, 2) }]
}

/**
 * The results of a round that ran several tools at once. DB-GPT sends them as
 * one text output holding a JSON array of `{ name, success, content }`.
 * @param {string} content - a text output.
 * @returns {{ name: string, success?: boolean, content: unknown }[] | undefined} the results, or undefined for other text.
 */
function batchResults(content) {
  if (!content.trimStart().startsWith('[')) return undefined
  const batch = parseJson(content)
  return Array.isArray(batch) && batch.length > 0
    && batch.every(item => item !== null && typeof item === 'object' && typeof item.name === 'string')
    ? batch
    : undefined
}

/** @param {{ type: string, content: string }} output - one output. @returns {string} it as Markdown for the view. */
function outputMarkdown({ type, content }) {
  if (type === 'markdown') return readableCharts(content)
  if (type === 'text') return content
  if (type === 'code') return fence(content)
  if (type === 'html') return `（DB-GPT 生成了一份 HTML 内容，共 ${content.length} 字，可在 DB-GPT 网页的这次对话里查看。）`
  return fence(content, 'json')
}

/**
 * One step's outputs as Markdown for the conversation view. A round that ran
 * several tools lists each call with its SQL and result.
 * @param {{ type: string, content: string }[]} outputs - outputs in arrival order.
 * @param {string} [input] - the round's tool-call arguments as JSON: one object, or an array for several calls.
 * @returns {string} the Markdown.
 */
export function stepOutput(outputs, input) {
  const args = input === undefined ? undefined : parseJson(input)
  const calls = Array.isArray(args) ? args : args !== null && typeof args === 'object' ? [args] : []
  const parts = []
  const batched = outputs.map(output => (output.type === 'text' ? batchResults(output.content) : undefined))
  if (!batched.some(Boolean) && calls.length === 1) parts.push(sqlOf(calls[0]))
  outputs.forEach((output, index) => {
    const batch = batched[index]
    if (batch === undefined) {
      parts.push(outputMarkdown(output))
      return
    }
    batch.forEach((result, call) => {
      parts.push(`**${call + 1}. ${result.name}**${result.success === false ? '（失败）' : ''}`, sqlOf(calls[call]))
      parts.push(...chunksOf(result.content).map(outputMarkdown))
    })
  })
  return clip(parts.filter(part => part !== undefined && part.trim() !== '').join('\n\n'), STEP_OUTPUT_LIMIT)
}

/** Most characters of one step's output the model reads. */
const MODEL_STEP_LIMIT = 2_000

/**
 * Render the canonical value of `dbgpt_agent` for the model.
 * @param {{ database: string, final: string, steps: { title: string, action?: string, thought?: string, status: string, output: string }[] }} value - the run.
 * @returns {string} Markdown for the model.
 */
export function renderAgent(value) {
  const parts = [`Database: ${value.database}`, `DB-GPT data agent's conclusion, already shown to the user:\n\n${value.final}`]
  if (value.steps.length > 0) {
    const steps = value.steps.map((step, index) => {
      const lines = [`${index + 1}. ${step.title}${step.action && step.action !== step.title ? ` (${step.action})` : ''}${step.status === 'failed' ? ' [failed]' : ''}`]
      if (step.thought) lines.push(`Thought: ${step.thought}`)
      if (step.output) lines.push(clip(step.output, MODEL_STEP_LIMIT))
      return lines.join('\n')
    })
    parts.push(`Steps DB-GPT took:\n\n${steps.join('\n\n')}`)
  }
  return parts.join('\n\n')
}
