import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseChatData } from '../src/dbgpt-api.js'
import { columnsOf, renderDatabases, renderQuery } from '../src/render.js'

// Answer recorded from DB-GPT 0.8.2 /api/v2/chat/completions in chat_data mode.
const RECORDED = '根据提供的表结构，当前可用的表只有 walmart_sales。需要查询该表的总行数。\n'
  + '<chart-view content="{"type": "response_table", "sql": "SELECT \'walmart_sales\' AS table_name, COUNT(*) AS row_count FROM walmart_sales;", '
  + '"data": [{"table_name": "walmart_sales", "row_count": 6435}]}" />'

test('parseChatData splits the explanation, SQL, chart type, and rows', () => {
  const parsed = parseChatData(RECORDED)
  assert.equal(parsed.summary, '根据提供的表结构，当前可用的表只有 walmart_sales。需要查询该表的总行数。')
  assert.equal(parsed.sql, 'SELECT \'walmart_sales\' AS table_name, COUNT(*) AS row_count FROM walmart_sales;')
  assert.equal(parsed.chartType, 'response_table')
  assert.deepEqual(parsed.rows, [{ table_name: 'walmart_sales', row_count: 6435 }])
  assert.equal(parsed.error, undefined)
})

test('parseChatData decodes XML character references left in the attribute', () => {
  const parsed = parseChatData('x\n<chart-view content="{"type": "response_bar_chart", "sql": "SELECT a FROM t WHERE b &lt; 3 AND c = \'R&amp;D\'", "data": []}" />')
  assert.equal(parsed.sql, 'SELECT a FROM t WHERE b < 3 AND c = \'R&D\'')
  assert.deepEqual(parsed.rows, [])
})

test('parseChatData reports a failed query with its SQL', () => {
  const content = '查询各门店销量 \\n <span style="color:red">ERROR!</span>no such column: store_id \n '
    + '<chart-view content="{"sql": "SELECT store_id FROM walmart_sales", "type": "response_table", "data": []}" />'
  const parsed = parseChatData(content)
  assert.equal(parsed.summary, '查询各门店销量')
  assert.equal(parsed.error, 'no such column: store_id')
  assert.equal(parsed.sql, 'SELECT store_id FROM walmart_sales')
})

test('parseChatData keeps a direct answer without a query', () => {
  assert.deepEqual(parseChatData('这个问题不需要查询数据库。'), { summary: '这个问题不需要查询数据库。' })
})

test('renderQuery shows the row count, truncation, and a Markdown table', () => {
  const rows = [{ store: 1, sales: 10 }, { store: 2, sales: null }]
  const text = renderQuery({
    database: 'Walmart_Sales', summary: 's', sql: 'SELECT 1', chartType: 'response_bar_chart',
    rowCount: 5, columns: columnsOf(rows), rows,
  })
  assert.match(text, /Result: 5 row\(s\), first 2 shown\./)
  assert.match(text, /\| store \| sales \|\n\| --- \| --- \|\n\| 1 \| 10 \|\n\| 2 \|  \|/)
  assert.match(text, /bar chart/)
})

test('renderQuery escapes pipes and newlines in cells', () => {
  const text = renderQuery({ database: 'd', summary: '', rowCount: 1, columns: ['a'], rows: [{ a: 'x|y\nz' }] })
  assert.match(text, /\| x\\\|y z \|/)
})

test('renderDatabases lists names, types, and descriptions', () => {
  assert.equal(
    renderDatabases({ databases: [{ name: 'Walmart_Sales', type: 'sqlite', description: 'Default example' }] }),
    'Databases connected in DB-GPT:\n- Walmart_Sales (sqlite): Default example',
  )
  assert.match(renderDatabases({ databases: [] }), /no databases/)
})
