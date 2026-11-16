/**
 * Resolve how the managed DB-GPT server is launched: which model endpoint,
 * model, and API key it uses, and the TOML configuration it reads. The key is
 * never written to the TOML file; it reaches the child process through its
 * environment only. Embeddings use their own credential when it is set and
 * the model's key otherwise.
 */
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Environment variables the generated TOML reads secrets from. */
export const LLM_KEY_ENV = 'DBGPT_LLM_API_KEY'
export const EMBEDDING_KEY_ENV = 'DBGPT_EMBEDDING_API_KEY'

/** A configuration problem the user fixes in the plugin's settings; the message is user-facing Chinese. */
export class DbgptConfigError extends Error {
  /** @param {string} message - what is wrong and how to fix it. */
  constructor(message) {
    super(message)
    this.name = 'DbgptConfigError'
    this.code = 'DBGPT_CONFIG'
  }
}

/**
 * Convert the Anthropic Messages base URL a dsh provider uses into the
 * OpenAI-compatible base URL of the same service: `/anthropic` becomes `/v1`,
 * and a URL without a trailing `/v1` gains one.
 * @param {string} url - provider base URL.
 * @returns {string} OpenAI-compatible base URL ending in `/v1`.
 */
export function openAIBaseURL(url) {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/anthropic')) return `${trimmed.slice(0, -'/anthropic'.length)}/v1`
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * Join an OpenAI-compatible base URL and the embeddings path.
 * @param {string} base - base URL, or a URL that already ends in `/embeddings`.
 * @returns {string} embeddings endpoint.
 */
export function embeddingsURL(base) {
  const trimmed = base.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/**
 * Read a nested section by path.
 * @param {unknown} value - section root.
 * @param {readonly string[]} path - keys to descend.
 * @returns {unknown} the nested value, or undefined.
 */
function descend(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** @param {unknown} value @returns {string | undefined} a non-empty trimmed string. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Endpoint defaults of a provider whose directory entry reports none, keyed by
 * its settings namespace: the environment variables it reads and its built-in URL.
 * @typedef {Record<string, { env: readonly string[], baseURL: string }>} EndpointDefaults
 */

/**
 * Locate the endpoint, model, and credential reference of dsh's current
 * default model provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {EndpointDefaults} [endpointDefaults] - fallbacks for providers that report no default endpoint.
 * @returns {{ provider: string, model: string, baseURL: string, keyRef: string }} the provider facts.
 */
export function dshProvider(ctx, endpointDefaults = {}) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection === undefined) {
    throw new DbgptConfigError('读取不到 dsh 当前的默认模型。请在 DB-GPT 插件设置里把模型来源改为“单独配置”。')
  }
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const provider = llm?.listConfigurableProviders().find(entry => entry.provider === selection.provider)
  if (provider === undefined || settings === undefined) {
    throw new DbgptConfigError(`dsh 的模型提供方 ${selection.provider} 不能被复用。请在 DB-GPT 插件设置里把模型来源改为“单独配置”。`)
  }
  const section = descend(
    settings.describe({ redactSecrets: true }).find(entry => entry.ns === provider.settingsNs)?.value,
    provider.settingsPath,
  )
  const keyRef = text(section?.apiKeyEnv)
  if (keyRef === undefined) {
    throw new DbgptConfigError(`dsh 的模型提供方 ${provider.displayName} 不使用 API Key，无法复用。请在 DB-GPT 插件设置里把模型来源改为“单独配置”。`)
  }
  const fallback = endpointDefaults[provider.settingsNs]
  const envNames = provider.baseURLEnv ?? fallback?.env ?? []
  const fromEnv = envNames.map(name => text(process.env[name])).find(value => value !== undefined)
  const baseURL = text(section?.baseURL) ?? fromEnv ?? provider.defaultBaseURL ?? fallback?.baseURL
  if (baseURL === undefined) {
    throw new DbgptConfigError(`dsh 的模型提供方 ${provider.displayName} 没有配置地址。请在 DB-GPT 插件设置里填写 API 地址。`)
  }
  return { provider: selection.provider, model: selection.model, baseURL, keyRef }
}

/**
 * Read a secret by credential reference: from dsh's credential store when the
 * composition mounts one (the Web app does), otherwise from the environment
 * variable of the same name, as compositions without the store do.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} ref - credential reference, such as `DEEPSEEK_API_KEY`.
 * @returns {Promise<{ value: string } | undefined>} the secret, or undefined when unset.
 */
async function resolveCredential(ctx, ref) {
  const store = ctx.get('credentials')
  if (store !== undefined) return await store.resolve(ref)
  const value = text(process.env[ref])
  return value === undefined ? undefined : { value }
}

/**
 * Resolve the model endpoint DB-GPT uses from the plugin configuration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin configuration.
 * @param {EndpointDefaults} [endpointDefaults] - fallbacks for providers that report no default endpoint.
 * @returns {Promise<{ source: 'dsh' | 'custom', model: string, baseURL: string, apiKey: string, keyRef: string }>} the endpoint and its key.
 */
export async function resolveModel(ctx, config, endpointDefaults) {
  const source = config.llmSource.get()
  const modelOverride = text(config.llmModel.get())
  const baseOverride = text(config.llmBaseURL.get())
  let model
  let baseURL
  let keyRef
  if (source === 'dsh') {
    const provider = dshProvider(ctx, endpointDefaults)
    model = modelOverride ?? provider.model
    baseURL = baseOverride ?? openAIBaseURL(provider.baseURL)
    keyRef = provider.keyRef
  } else {
    if (baseOverride === undefined) throw new DbgptConfigError('模型来源为“单独配置”时必须填写 API 地址。')
    if (modelOverride === undefined) throw new DbgptConfigError('模型来源为“单独配置”时必须填写模型名称。')
    model = modelOverride
    baseURL = baseOverride.replace(/\/+$/, '')
    keyRef = config.llmApiKeyEnv.get()
  }
  const credential = await resolveCredential(ctx, keyRef)
  if (credential === undefined) {
    throw new DbgptConfigError(source === 'dsh'
      ? `dsh 的 API Key（凭据 ${keyRef}）还没有配置。请先在 dsh 的模型设置里填写。`
      : `还没有填写 DB-GPT 使用的 API Key（凭据 ${keyRef}）。请在 DB-GPT 插件设置里填写。`)
  }
  return { source, model, baseURL, apiKey: credential.value, keyRef }
}

/**
 * Path of the generated TOML for one port. The path also identifies a server
 * this plugin started: a process whose command line names it is the plugin's own.
 * @param {number} port - server port.
 * @returns {string} absolute file path.
 */
export function tomlPath(port) {
  return join(tmpdir(), 'dsh-plugin-dbgpt', `dbgpt-${port}.toml`)
}

/**
 * Choose the DB-GPT model provider. DeepSeek's own API gets DB-GPT's DeepSeek
 * provider, which turns thinking off so DB-GPT can parse the answer; every
 * other endpoint gets the generic OpenAI-compatible provider.
 * @param {string} setting - `auto` or an explicit DB-GPT provider.
 * @param {string} baseURL - OpenAI-compatible base URL.
 * @returns {string} DB-GPT provider name.
 */
export function dbgptProvider(setting, baseURL) {
  if (setting !== 'auto') return setting
  let host
  try { host = new URL(baseURL).hostname }
  catch (_invalid) { throw new DbgptConfigError(`API 地址 ${baseURL} 不是有效的 URL。`) }
  return host === 'api.deepseek.com' ? 'proxy/deepseek' : 'proxy/openai'
}

/**
 * Resolve the complete launch specification of the managed server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin configuration.
 * @param {EndpointDefaults} [endpointDefaults] - fallbacks for providers that report no default endpoint.
 * @returns {Promise<object>} launch specification; `apiKey` and `embeddingApiKey` are its secret fields.
 */
export async function resolveLaunch(ctx, config, endpointDefaults) {
  const home = text(config.dbgptHome.get())
  if (home === undefined || !isAbsolute(home)) throw new DbgptConfigError('DB-GPT 目录必须是绝对路径。')
  const llm = await resolveModel(ctx, config, endpointDefaults)
  const port = config.port.get()
  const [program, ...args] = config.launcher
  const embeddingBase = text(config.embeddingBaseURL.get()) ?? llm.baseURL
  const embeddingKey = await resolveCredential(ctx, config.embeddingApiKeyEnv.get())
  return {
    home,
    argv: [isAbsolute(program) ? program : resolve(home, program), ...args, '--config', tomlPath(port)],
    port,
    bindHost: config.bindHost.get(),
    language: config.language.get(),
    source: llm.source,
    provider: dbgptProvider(config.llmProvider.get(), llm.baseURL),
    model: llm.model,
    baseURL: llm.baseURL,
    keyRef: llm.keyRef,
    apiKey: llm.apiKey,
    contextLength: config.llmContextLength.get(),
    embeddingModel: config.embeddingModel.get(),
    embeddingURL: embeddingsURL(embeddingBase),
    embeddingApiKey: embeddingKey?.value ?? llm.apiKey,
  }
}

/**
 * Whether two launch specifications start the same server.
 * @param {object} a - running specification.
 * @param {object} b - requested specification.
 * @returns {boolean} true when no restart is needed.
 */
export function sameLaunch(a, b) {
  const keys = [
    'home', 'argv', 'port', 'bindHost', 'language', 'provider', 'model', 'baseURL', 'apiKey', 'contextLength',
    'embeddingModel', 'embeddingURL', 'embeddingApiKey',
  ]
  return keys.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

/**
 * Render the DB-GPT TOML for a launch. Paths stay relative so the server, run
 * from `home`, reuses the checkout's metadata database and vector store; the
 * datasource encryption key keeps DB-GPT's default unless `DBGPT_ENCRYPT_KEY` is set.
 * @param {object} spec - launch specification.
 * @returns {string} TOML text without secrets.
 */
export function renderToml(spec) {
  const s = value => JSON.stringify(String(value))
  return `# Generated by dsh-plugin-dbgpt on every start; edits are overwritten.
[system]
language = ${s(spec.language)}
api_keys = []
encrypt_key = "\${env:DBGPT_ENCRYPT_KEY:-your_secret_key}"

[service.web]
host = ${s(spec.bindHost)}
port = ${spec.port}
cors_allowed_origins = "\${env:DBGPT_CORS_ALLOWED_ORIGINS:-*}"

[service.web.database]
type = "sqlite"
path = "pilot/meta_data/dbgpt.db"

[rag.storage]
[rag.storage.vector]
type = "chroma"
persist_path = "pilot/data"

[models]
[[models.llms]]
name = ${s(spec.model)}
provider = ${s(spec.provider)}
api_base = ${s(spec.baseURL)}
api_key = "\${env:${LLM_KEY_ENV}}"
context_length = ${spec.contextLength}
${spec.provider === 'proxy/deepseek' ? 'thinking_enabled = false\n' : ''}
[[models.embeddings]]
name = ${s(spec.embeddingModel)}
provider = "proxy/openai"
api_url = ${s(spec.embeddingURL)}
api_key = "\${env:${EMBEDDING_KEY_ENV}}"
`
}
