/** Model-facing Markdown for DB-GPT tool results. */

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
  if (value.chartType && value.chartType !== 'response_table' && value.rowCount) {
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
