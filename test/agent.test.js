import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { AgentRun, EventStreamParser, runAgent } from '../src/dbgpt-api.js'
import { readableCharts, renderAgent, stepOutput } from '../src/render.js'

// Stream recorded from DB-GPT 0.8.2 POST /api/v1/chat/react-agent ("一共有多少家门店？" on Walmart_Sales).
const RECORDED = [
  '{"type": "context.status", "used": 5011, "budget": 115904, "ratio": 0.0432, "state": "normal", "compact_layer": null}',
  '{"type": "task.preview", "content": "统计门店数量", "round": 1}',
  '{"type": "step.start", "step": 1, "id": "step-1", "title": "sql_query", "detail": "Thought/Action/Observation"}',
  '{"type": "step.meta", "id": "step-1", "thought": "用户问门店总数，直接对 Store 去重计数", "action_intention": "统计门店数量", "action_reason": null, "action": "sql_query", "action_input": null, "title": "sql_query"}',
  '{"type": "step.chunk", "id": "step-1", "output_type": "markdown", "content": "| store_count |\\n| --- |\\n| 45 |"}',
  '{"type": "step.done", "id": "step-1", "status": "done"}',
  '{"type": "step.start", "step": 2, "id": "step-2", "title": "思考中", "detail": "Thought/Action/Observation"}',
  '{"type": "step.meta", "id": "step-2", "thought": null, "action_intention": null, "action_reason": null, "action": "terminate", "action_input": null, "title": "terminate"}',
  '{"type": "final", "protocol_version": 2, "content": "数据库 Walmart_Sales 的 walmart_sales 表中，按 Store 字段去重统计，一共有 **45 家门店**。", "citations": []}',
  '{"type": "done"}',
].map(line => `data: ${line}\n\n`).join('')

/** @param {string} stream - raw stream text. @param {number} piece - characters per push. @returns {AgentRun} the folded run. */
function fold(stream, piece = stream.length) {
  const parser = new EventStreamParser()
  const run = new AgentRun()
  for (let start = 0; start < stream.length; start += piece) {
    for (const event of parser.push(stream.slice(start, start + piece))) run.apply(event)
  }
  for (const event of parser.end()) run.apply(event)
  return run
}

test('a recorded run folds into its conclusion and one step, without the terminate round', () => {
  const { final, failed, steps } = fold(RECORDED).result()
  assert.equal(final, '数据库 Walmart_Sales 的 walmart_sales 表中，按 Store 字段去重统计，一共有 **45 家门店**。')
  assert.equal(failed, false)
  assert.deepEqual(steps, [{
    title: 'sql_query',
    thought: '用户问门店总数，直接对 Store 去重计数',
    intention: '统计门店数量',
    action: 'sql_query',
    status: 'done',
    outputs: [{ type: 'markdown', content: '| store_count |\n| --- |\n| 45 |' }],
  }])
})

test('events split across arbitrary read boundaries parse the same', () => {
  assert.deepEqual(fold(RECORDED, 7).result(), fold(RECORDED).result())
})

test('a recorded round of parallel SQL queries shows each query with its SQL and rows, under the final plan', async () => {
  // Recorded from DB-GPT 0.8.2: two sql_query calls in one round, wrapped in todowrite planning rounds.
  const stream = await readFile(new URL('./fixtures/react-parallel-sql.txt', import.meta.url), 'utf8')
  const { plan, steps } = fold(stream, 100).result()
  assert.deepEqual(plan.map(task => task.status), ['completed', 'completed', 'completed'])
  assert.equal(steps.length, 1, 'thinking placeholders and todowrite rounds are not steps')
  assert.equal(steps[0].action, 'sql_query, sql_query')
  const output = stepOutput(steps[0].outputs, steps[0].input)
  assert.match(output, /^\*\*1\. sql_query\*\*\n\n```sql\nSELECT ROUND\(AVG\(Weekly_Sales\), 2\) AS avg_holiday_weekly_sales/)
  assert.match(output, /\| avg_holiday_weekly_sales \| holiday_weeks \|\n\| --- \| --- \|\n\| 1148530\.48 \| 180 \|/)
  assert.match(output, /\*\*2\. sql_query\*\*\n\n```sql\nSELECT Store/)
  assert.match(output, /\| Store \| total_sales \|\n\| --- \| --- \|\n\| 33 \| 12957836\.67 \|/)
  assert.doesNotMatch(output, /call_id/)
})

test('several queries in one run each stay a step, and split text joins back', () => {
  const stream = [
    { type: 'step.start', id: 'step-1', title: 'sql_query' },
    { type: 'step.chunk', id: 'step-1', output_type: 'text', content: 'SQL_QUERY_FAILED: no such ' },
    { type: 'step.chunk', id: 'step-1', output_type: 'text', content: 'column: store_id' },
    { type: 'step.done', id: 'step-1', status: 'failed' },
    { type: 'step.start', id: 'step-2', title: 'sql_query' },
    { type: 'step.chunk', id: 'step-2', output_type: 'markdown', content: '| a |\n| --- |\n| 1 |' },
    { type: 'step.chunk', id: 'step-2', output_type: 'markdown', content: '| b |\n| --- |\n| 2 |' },
    { type: 'step.done', id: 'step-2', status: 'done' },
    { type: 'final', content: 'done' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const { steps } = fold(stream).result()
  assert.equal(steps.length, 2)
  assert.equal(steps[0].status, 'failed')
  assert.deepEqual(steps[0].outputs, [{ type: 'text', content: 'SQL_QUERY_FAILED: no such column: store_id' }])
  assert.equal(steps[1].outputs.length, 2)
})

test('a broken run is marked failed, and a non-JSON payload is kept as a message', () => {
  const run = fold('data: {"type": "final", "content": "React agent failed: boom"}\n\ndata:plain fallback\n\n')
  assert.equal(run.result().failed, true)
  assert.deepEqual(run.messages, ['plain fallback'])
})

test('readableCharts turns a vis-db-chart fence into its SQL and rows', () => {
  const chart = { sql: 'SELECT month, total FROM t', type: 'response_line_chart', title: '', data: [{ month: '2011-01', total: 1 }] }
  const text = readableCharts(`前言\n\n\`\`\`vis-db-chart\n${JSON.stringify(chart)}\n\`\`\``)
  assert.match(text, /^前言\n\n\*\*图表：折线图\*\*/)
  assert.match(text, /```sql\nSELECT month, total FROM t\n```/)
  assert.match(text, /\| month \| total \|\n\| --- \| --- \|\n\| 2011-01 \| 1 \|/)
  assert.equal(readableCharts('```vis-db-chart\nnot json\n```'), '```vis-db-chart\nnot json\n```')
})

test('stepOutput fences code safely and does not inline HTML', () => {
  assert.equal(stepOutput([{ type: 'code', content: 'a ``` b' }]), '````\na ``` b\n````')
  assert.match(stepOutput([{ type: 'html', content: '<html></html>' }]), /HTML 内容，共 13 字/)
})

test('renderAgent gives the model the conclusion and the steps', () => {
  const text = renderAgent({
    database: 'Walmart_Sales',
    final: '45 家门店',
    steps: [{ title: '统计门店数量', action: 'sql_query', thought: '去重计数', status: 'done', output: '| n |\n| --- |\n| 45 |' }],
  })
  assert.match(text, /conclusion, already shown to the user:\n\n45 家门店/)
  assert.match(text, /1\. 统计门店数量 \(sql_query\)\nThought: 去重计数\n\| n \|/)
})

test('runAgent sends the question with its database and dismisses questions the agent asks', async (t) => {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      seen.push({ url: request.url, body: body === '' ? undefined : JSON.parse(body) })
      if (request.url !== '/api/v1/chat/react-agent') {
        response.end('{"success": true}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"type": "step.start", "id": "step-1", "title": "question"}\n\n')
      response.write('data: {"type": "question.asked", "request_id": "q-1", "questions": [{"question": "按哪个时间字段？"}]}\n\n')
      response.end('data: {"type": "final", "content": "结论"}\n\ndata: {"type": "done"}\n\n')
    })
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => server.close())
  const endpoint = `http://127.0.0.1:${server.address().port}`

  const run = await runAgent(endpoint, {
    model: 'deepseek-flash', database: 'Walmart_Sales', question: '最新的温度', conversation: 'c-1', language: 'zh',
  }, AbortSignal.timeout(5000))

  assert.equal(run.final, '结论')
  assert.match(run.steps[0].outputs[0].content, /按哪个时间字段？.*插件已跳过/)
  assert.deepEqual(seen[0].body, {
    conv_uid: 'c-1',
    chat_mode: 'chat_react_agent',
    model_name: 'deepseek-flash',
    user_input: '[Database: Walmart_Sales] 最新的温度',
    temperature: 0.6,
    max_new_tokens: 8000,
    select_param: '',
    ext_info: { locale: 'zh', database_name: 'Walmart_Sales' },
  })
  assert.equal(seen[1].url, '/api/v1/chat/question/q-1/reject')
})

test('runAgent reports a stream that ends without a conclusion', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"type": "done"}\n\n')
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => server.close())
  await assert.rejects(
    runAgent(`http://127.0.0.1:${server.address().port}`, { model: 'm', database: 'd', question: 'q', conversation: 'c', language: 'zh' }, AbortSignal.timeout(5000)),
    { code: 'DBGPT_REQUEST', message: /没有给出结论/ },
  )
})
