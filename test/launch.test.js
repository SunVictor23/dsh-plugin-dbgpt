import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DbgptConfigError, embeddingsURL, openAIBaseURL, renderToml, resolveLaunch, resolveModel, sameLaunch,
} from '../src/launch.js'

/** Wrap plain values the way the Loader hands volatile fields to a plugin. */
function volatileConfig(values) {
  const config = {}
  for (const [key, value] of Object.entries(values)) {
    config[key] = ['launcher', 'manage', 'endpoint', 'startupTimeoutMs', 'requestTimeoutMs'].includes(key)
      ? value
      : { get: () => value }
  }
  return config
}

const baseValues = {
  dbgptHome: '/srv/DB-GPT',
  launcher: ['.venv/bin/dbgpt', 'start', 'webserver'],
  bindHost: '0.0.0.0',
  port: 5670,
  language: 'zh',
  llmSource: 'dsh',
  llmModel: '',
  llmBaseURL: '',
  llmApiKeyEnv: 'DBGPT_LLM_API_KEY',
  llmContextLength: 131072,
  embeddingModel: 'text-embedding-3-large',
  embeddingBaseURL: '',
}

/** A context whose services answer like a dsh web composition with one DeepSeek-route provider. */
function fakeContext({ baseURL = 'https://modelservice.jdcloud.com/anthropic', keys = { DEEPSEEK_API_KEY: 'dsh-key', DBGPT_LLM_API_KEY: 'own-key' } } = {}) {
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'DeepSeek-V4-Pro-0813' }) },
    llm: {
      listConfigurableProviders: () => [{
        provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [],
        defaultBaseURL: 'https://api.deepseek.com/anthropic', baseURLEnv: ['DEEPSEEK_BASE_URL'],
      }],
    },
    settings: {
      describe: () => [{ ns: 'llm-deepseek', value: { baseURL, apiKeyEnv: 'DEEPSEEK_API_KEY' } }],
    },
  }
  return {
    get: name => services[name],
    credentials: { resolve: async ref => keys[ref] === undefined ? undefined : { value: keys[ref], source: 'file' } },
  }
}

test('openAIBaseURL maps Anthropic endpoints to their OpenAI-compatible base', () => {
  assert.equal(openAIBaseURL('https://modelservice.jdcloud.com/anthropic'), 'https://modelservice.jdcloud.com/v1')
  assert.equal(openAIBaseURL('https://api.deepseek.com/anthropic/'), 'https://api.deepseek.com/v1')
  assert.equal(openAIBaseURL('https://modelservice.jdcloud.com/v1'), 'https://modelservice.jdcloud.com/v1')
  assert.equal(openAIBaseURL('https://example.com'), 'https://example.com/v1')
})

test('embeddingsURL appends the embeddings path once', () => {
  assert.equal(embeddingsURL('https://x.test/v1/'), 'https://x.test/v1/embeddings')
  assert.equal(embeddingsURL('https://x.test/v1/embeddings'), 'https://x.test/v1/embeddings')
})

test('dsh source reuses the provider endpoint, key, and default model', async () => {
  const llm = await resolveModel(fakeContext(), volatileConfig(baseValues))
  assert.deepEqual(llm, {
    source: 'dsh', model: 'DeepSeek-V4-Pro-0813', baseURL: 'https://modelservice.jdcloud.com/v1', apiKey: 'dsh-key', keyRef: 'DEEPSEEK_API_KEY',
  })
})

test('dsh source honours model and URL overrides', async () => {
  const llm = await resolveModel(fakeContext(), volatileConfig({ ...baseValues, llmModel: 'gpt-5.5', llmBaseURL: 'https://gw.test/v1' }))
  assert.equal(llm.model, 'gpt-5.5')
  assert.equal(llm.baseURL, 'https://gw.test/v1')
  assert.equal(llm.apiKey, 'dsh-key')
})

test('custom source requires a URL and a model and reads its own key', async () => {
  const ctx = fakeContext()
  await assert.rejects(resolveModel(ctx, volatileConfig({ ...baseValues, llmSource: 'custom', llmModel: 'm' })), DbgptConfigError)
  await assert.rejects(resolveModel(ctx, volatileConfig({ ...baseValues, llmSource: 'custom', llmBaseURL: 'https://a.test/v1' })), DbgptConfigError)
  const llm = await resolveModel(ctx, volatileConfig({ ...baseValues, llmSource: 'custom', llmModel: 'm', llmBaseURL: 'https://a.test/v1/' }))
  assert.deepEqual(llm, { source: 'custom', model: 'm', baseURL: 'https://a.test/v1', apiKey: 'own-key', keyRef: 'DBGPT_LLM_API_KEY' })
})

test('a missing key is a configuration error naming the credential', async () => {
  const ctx = fakeContext({ keys: {} })
  await assert.rejects(resolveModel(ctx, volatileConfig(baseValues)), /DEEPSEEK_API_KEY/)
})

test('resolveLaunch builds argv, embeddings URL, and a TOML without the key', async () => {
  const spec = await resolveLaunch(fakeContext(), volatileConfig(baseValues))
  assert.equal(spec.argv[0], '/srv/DB-GPT/.venv/bin/dbgpt')
  assert.deepEqual(spec.argv.slice(1, 3), ['start', 'webserver'])
  assert.equal(spec.argv[3], '--config')
  assert.match(spec.argv[4], /dsh-plugin-dbgpt[/\\]dbgpt-5670\.toml$/)
  assert.equal(spec.embeddingURL, 'https://modelservice.jdcloud.com/v1/embeddings')
  const toml = renderToml(spec)
  assert.doesNotMatch(toml, /dsh-key/)
  assert.match(toml, /name = "DeepSeek-V4-Pro-0813"/)
  assert.match(toml, /api_key = "\$\{env:DBGPT_LLM_API_KEY\}"/)
  assert.match(toml, /port = 5670/)
})

test('resolveLaunch rejects a relative DB-GPT directory', async () => {
  await assert.rejects(resolveLaunch(fakeContext(), volatileConfig({ ...baseValues, dbgptHome: 'DB-GPT' })), DbgptConfigError)
})

test('sameLaunch notices a changed key or model but not unrelated fields', async () => {
  const a = await resolveLaunch(fakeContext(), volatileConfig(baseValues))
  const b = await resolveLaunch(fakeContext(), volatileConfig(baseValues))
  assert.ok(sameLaunch(a, b))
  assert.ok(!sameLaunch(a, { ...b, apiKey: 'other' }))
  assert.ok(!sameLaunch(a, { ...b, model: 'other' }))
  assert.ok(sameLaunch(a, { ...b, source: 'custom' }))
})
