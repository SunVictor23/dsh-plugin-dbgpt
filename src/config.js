/** Configuration schema of the `dbgpt` row. Volatile fields are editable from the plugin's settings page. */
import z from '@deepseek-ai/schemastery'

/** Credential reference the custom model source reads its API key from. */
export const DEFAULT_KEY_REF = 'DBGPT_LLM_API_KEY'
/** Credential reference of a separate embeddings key. */
export const DEFAULT_EMBEDDING_KEY_REF = 'DBGPT_EMBEDDING_API_KEY'

export const Config = z.object({
  dbgptHome: z.string().required().volatile()
    .description('DB-GPT checkout directory; the server runs with it as working directory, so its pilot/ data is reused.'),
  launcher: z.array(z.string()).min(1).default(['.venv/bin/dbgpt', 'start', 'webserver'])
    .description('Command that starts the DB-GPT webserver; a relative program path resolves against dbgptHome. `--config <generated toml>` is appended.'),
  manage: z.boolean().default(true)
    .description('Start DB-GPT when the plugin loads and stop it when the plugin unloads. False connects to `endpoint` instead.'),
  endpoint: z.string()
    .description('DB-GPT base URL used when manage is false.'),
  bindHost: z.string().default('0.0.0.0').volatile()
    .description('Address the managed DB-GPT webserver listens on.'),
  port: z.number().step(1).min(1).max(65535).default(5670).volatile()
    .description('Port the managed DB-GPT webserver listens on.'),
  language: z.union(['zh', 'en']).default('zh').volatile()
    .description('DB-GPT system language.'),
  startupTimeoutMs: z.number().step(1).min(1000).default(180_000)
    .description('How long a managed start may take before it is reported as failed.'),
  mode: z.union(['agent', 'sql']).default('agent').volatile()
    .description('agent: DB-GPT\'s ReAct data agent plans, queries, and retries on its own, then dsh answers from its conclusion (tool dbgpt_agent). '
      + 'sql: DB-GPT writes and runs one query per call and dsh reasons over the rows (tool dbgpt_query).'),
  requestTimeoutMs: z.number().step(1).min(1000).default(300_000)
    .description('Deadline for one DB-GPT request in sql mode.'),
  agentTimeoutMs: z.number().step(1).min(1000).default(960_000)
    .description('Deadline for one data-agent run in agent mode; DB-GPT itself stops an agent after 900 seconds.'),
  maxRows: z.number().step(1).min(1).default(50).volatile()
    .description('Result rows returned to the model per query; the row count is always reported.'),
  llmSource: z.union(['dsh', 'custom']).default('dsh').volatile()
    .description('dsh: reuse the endpoint and API key of dsh\'s current model provider. custom: use llmBaseURL and the key stored under llmApiKeyEnv.'),
  llmModel: z.string().volatile()
    .description('Model DB-GPT calls. Empty with llmSource dsh means dsh\'s current default model; required with custom.'),
  llmBaseURL: z.string().volatile()
    .description('OpenAI-compatible base URL (ending in /v1). Required with custom; with dsh it overrides the URL derived from dsh\'s provider.'),
  llmApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_REF).volatile()
    .description('Credential reference holding the custom source\'s API key.'),
  llmContextLength: z.number().step(1).min(1024).default(131_072).volatile()
    .description('Context window DB-GPT budgets prompts against.'),
  llmProvider: z.union(['auto', 'proxy/openai', 'proxy/deepseek']).default('auto').volatile()
    .description('DB-GPT model provider. auto picks proxy/deepseek (thinking off, so answers stay parseable) for api.deepseek.com and proxy/openai otherwise.'),
  embeddingModel: z.string().default('text-embedding-3-large').volatile()
    .description('Embedding model DB-GPT uses for schema retrieval and knowledge bases.'),
  embeddingBaseURL: z.string().volatile()
    .description('OpenAI-compatible base URL for embeddings; empty uses the LLM base URL.'),
  embeddingApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_EMBEDDING_KEY_REF).volatile()
    .description('Credential reference holding the embeddings API key; while it is unset the LLM key is used.'),
})
