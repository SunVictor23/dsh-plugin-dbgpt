# dsh-plugin-dbgpt

English | [中文](README.zh-CN.md)

A DeepSeek Harness (dsh) plugin that connects [DB-GPT](https://github.com/eosphoros-ai/DB-GPT). With the plugin enabled, when you ask dsh to look up data, count, compare, or rank, dsh hands the question to DB-GPT on its own. By default DB-GPT's ReAct data agent does the thinking: it plans, runs as many SQL queries as it needs, fixes failed ones, and writes the conclusion, which dsh shows as its answer.

## What it does

- **Manages the DB-GPT server**: enabling the plugin starts the DB-GPT web server (port 5670 by default); disabling the plugin or quitting dsh stops it. Changing a model setting restarts DB-GPT automatically.
- **Two analysis modes**, chosen under **Analysis mode** in the settings:
  - **ReAct agent** (default): dsh only passes the question on. DB-GPT's data agent reads the table structure, plans, runs SQL queries (several at once when it can), draws charts, fixes and reruns failed queries, and writes the conclusion. dsh shows "DB-GPT is analyzing…" while it works, then DB-GPT's conclusion; dsh's own model does not think about the answer again. Expand the row above the conclusion to see DB-GPT's plan and each step: its thought, the SQL, and the rows it got.
  - **Single SQL**: each call asks DB-GPT for one SQL query and its rows, and dsh's model reasons over them and asks follow-ups.
- **Tools and a command for dsh**: see [Tools](#tools).

Datasources are still added and managed on DB-GPT's own web page (`http://<server>:5670`), and the plugin uses them as they are. DB-GPT keeps its datasources and chat history under `DB-GPT/pilot/`; turning the plugin on or off leaves them alone.

## Tools

dsh's model calls these tools on its own when a question needs data. `dbgpt_list_databases` is always available; of the two question tools, dsh is offered only the one the analysis mode selects.

| Tool | Available in | What it does | Parameters | Returns |
| --- | --- | --- | --- | --- |
| `dbgpt_list_databases` | Both modes | Lists the databases connected in DB-GPT. dsh calls it first when it does not know which database holds the data. | None | Each database's name, type, and description |
| `dbgpt_agent` | **ReAct agent** mode (default) | Hands the question to DB-GPT's ReAct data agent, which plans, runs as many SQL queries as it needs, fixes failed ones, draws charts, and writes the conclusion. The conclusion is shown as dsh's answer and ends dsh's turn. A run takes at most 900 seconds. | `database`: a name from `dbgpt_list_databases`; `question`: the user's question as asked | DB-GPT's conclusion, its plan, and each step's thought, SQL, and rows |
| `dbgpt_query` | **Single SQL** mode | Has DB-GPT write and run one SQL query on one database; dsh's model reasons over the result. | `database`: a name from `dbgpt_list_databases`; `question`: one self-contained question | DB-GPT's explanation, the SQL, the row count, the first `maxRows` rows (default 50), and DB-GPT's suggested chart |

A follow-up question about the same database in the same dsh conversation continues DB-GPT's conversation, so DB-GPT sees the earlier questions and conclusions. The two modes keep separate DB-GPT conversations.

The plugin also adds a command you type in dsh:

| Command | What it does |
| --- | --- |
| `/dbgpt` or `/dbgpt status` | Shows DB-GPT's state, the analysis mode, the model DB-GPT uses, the DB-GPT web address, and the DB-GPT directory; when DB-GPT failed to start, also the reason |
| `/dbgpt restart` | Restarts the DB-GPT server the plugin manages |

## Installation

### One-step install (recommended on a new machine)

Copy this directory to the new machine and run:

```sh
bash install.sh
```

The script, in order:

1. Checks for git, Node.js (≥ 24.9), pnpm, and uv, and installs pnpm or uv if missing;
2. Clones DB-GPT from GitHub if its directory doesn't exist (pinned to the tested commit), then installs its dependencies with `uv sync`. If you brought `pilot/` over from the old machine, SQLite datasources that point at old paths are re-pointed to the new one;
3. Clones deepseek-harness if its directory doesn't exist, then runs `pnpm install` and `pnpm run build`;
4. Writes this machine's DB-GPT path, port, and embedding URL into this directory's `cordis.patch.yml`;
5. Installs the plugin into dsh's `web` profile;
6. Asks for the DeepSeek API key and the embedding API key (press Enter to skip) and stores them in `~/.dsh/.env` (mode 600). You can pass them in beforehand through the environment variables `DEEPSEEK_API_KEY` and `DBGPT_EMBEDDING_API_KEY`.

By default DB-GPT and deepseek-harness sit in this directory's parent, next to `dsh-plugin-dbgpt`. If yours are elsewhere, pass their paths:

```sh
bash install.sh --dbgpt-dir /data/DB-GPT --dsh-dir /data/deepseek-harness
```

Other options: `--port` changes the DB-GPT port, `--embedding-url none` uses the model's URL for embeddings, `--skip-build` skips installing dependencies and building, `--no-keys` skips the key prompts, and `--profile` installs into a different dsh profile. The script is safe to run again; steps already done are left as they are. Run `bash install.sh --help` for the full usage.

Then start dsh with `cd deepseek-harness && pnpm dsh web`. The plugin starts DB-GPT for you.

The old machine's DB-GPT datasources and chat history are all in `DB-GPT/pilot/`; to keep them, copy that directory into the new machine's DB-GPT directory before running the script. API keys stay in each machine's own dsh and don't move with the plugin; a key saved later in the dsh web UI takes precedence over `~/.dsh/.env`.

### Manual install

In the deepseek-harness directory (use `pnpm dsh` when running dsh from source):

```sh
pnpm dsh plugin --profile web add /mnt/workspace/sxk_dbgpt/dsh-plugin-dbgpt
```

You can also enter this directory's absolute path under **Plugins → Add plugin** in the dsh web UI. Restart dsh web afterwards for the plugin to load.

Prerequisites: DB-GPT's dependencies are installed with `uv sync`, so `DB-GPT/.venv/bin/dbgpt` exists, and `dbgptHome` in `cordis.patch.yml` is this machine's DB-GPT path.

## Turning the plugin on and off

On the **Plugins** page of the dsh web UI, find `dsh-plugin-dbgpt` and use its switch. Disabling it stops the DB-GPT server, and dsh no longer sees the two tools. Settings you saved stay in the profile and are used again when you re-enable it.

## Settings

On the **Plugins** page, open `dsh-plugin-dbgpt` and click **Configure** on the `dbgpt` row.

| Setting | Description |
| --- | --- |
| Analysis mode | **ReAct agent** (default): DB-GPT plans, runs as many queries as it needs, and writes the conclusion that dsh shows. **Single SQL**: DB-GPT runs one query per call and dsh's model reasons over the rows. Takes effect from dsh's next step. |
| Model source | **Reuse dsh's API**: use the URL and API key of dsh's current model provider. **Separate**: use the URL, model, and API key entered below. |
| Model | When reusing dsh, leave blank to use dsh's current default model. Required when separate. |
| API URL | OpenAI-compatible URL (ending in `/v1`). Required when separate; when reusing dsh, optional and replaces the derived URL. |
| API key | Shown only when separate. Stored in dsh's credential store (credential name `DBGPT_LLM_API_KEY`), never in a configuration file. |
| Embedding model / URL | Used by DB-GPT to retrieve table schemas and knowledge bases. Leave the URL blank to use the model's. |
| Embedding API key | Stored in dsh's credential store (credential name `DBGPT_EMBEDDING_API_KEY`). While it is unset, the model's API key is used. |
| DB-GPT directory / Port | Path of the DB-GPT project and the server port. |

DB-GPT calls models through the **OpenAI-compatible API**. When reusing dsh, the plugin converts dsh's URL to an OpenAI-compatible one by replacing a trailing `/anthropic` with `/v1`, for example `https://api.deepseek.com/anthropic` → `https://api.deepseek.com/v1`. DB-GPT can't use a model served only over the Anthropic API; in that case name another model under "Model".

When the URL is `api.deepseek.com`, the plugin has DB-GPT use its built-in DeepSeek integration (`proxy/deepseek`) with thinking mode off. Otherwise deepseek-v4-pro spends its output budget on thinking and DB-GPT gets no SQL back. Other URLs use the generic `proxy/openai`. The YAML field `llmProvider` sets it explicitly if needed. The ReAct agent drives its steps through the model's tool calls (function calling), so in that mode DB-GPT needs a model that supports them; DeepSeek models do.

The official DeepSeek API serves no embeddings. The vector data in this DB-GPT setup was built with JD Cloud's `text-embedding-3-large`, so the embedding URL is `https://modelservice.jdcloud.com/v1` and the embedding API key is a JD Cloud key.

You can also edit the YAML directly. Values saved from the settings page go into the `dbgpt` entry of `~/.dsh/profiles/web/cordis.patch.yml`; defaults for every profile are in this directory's `cordis.patch.yml`. All fields are described in [`src/config.js`](src/config.js). Those not on the settings page:

- `manage` (default `true`): when `false`, the plugin doesn't start DB-GPT and connects to the existing server at `endpoint` instead. `llmModel` must then name a model deployed in that server.
- `llmProvider` (default `auto`): how DB-GPT reaches the model, `proxy/openai` or `proxy/deepseek`.
- `llmApiKeyEnv`, `embeddingApiKeyEnv`: credential names of the two API keys.
- `launcher`: start command, `.venv/bin/dbgpt start webserver` by default.
- `bindHost` (default `0.0.0.0`), `language`, `startupTimeoutMs`, `llmContextLength`.
- `agentTimeoutMs` (default 960000): deadline for one ReAct agent run. DB-GPT itself stops an agent after 900 seconds or 60 rounds.
- `requestTimeoutMs` (default 300000) and `maxRows` (most rows returned to the model, default 50): single SQL mode only.

Each time the plugin starts DB-GPT, it writes the config file `/tmp/dsh-plugin-dbgpt/dbgpt-<port>.toml`. The file holds no secrets; the keys reach DB-GPT through environment variables. DB-GPT's own logs are still in `DB-GPT/logs/`.

## Development

The plugin is plain JavaScript (ESM) with no build step. After changing the code, turn the plugin off and on again on the Plugins page (or restart dsh).

| File | Contents |
| --- | --- |
| `src/index.js` | Plugin entry: registers the tools and the `/dbgpt` command, follows configuration changes |
| `src/config.js` | Configuration fields |
| `src/launch.js` | Resolves the model source (reuse dsh / separate) and generates DB-GPT's configuration |
| `src/supervisor.js` | Starts DB-GPT, waits until it is ready, restarts and stops it |
| `src/dbgpt-api.js` | Calls the DB-GPT API: single SQL answers (parses their `<chart-view>` result) and ReAct agent runs (reads their event stream into a plan, steps, and a conclusion) |
| `src/render.js` | Turns results into Markdown for the model, and agent steps into Markdown for the conversation view |
| `src/client.js` | Web side: the settings form on the Plugins page, and the `dbgpt_agent` view in the conversation |
| `cordis.patch.yml` | Configuration layer added to the profile on install |
| `install.sh` | One-step install on a new machine |

Run the unit tests:

```sh
npm test
```

To add a tool (say, one that uses another DB-GPT chat mode), register it with `defineTool` in `src/index.js` the way `dbgpt_query` is. The API docs are in deepseek-harness's `docs/user/develop/`.

## Known limitations

- In single SQL mode DB-GPT runs the SQL the model generates, and the plugin doesn't block writes. The ReAct agent's `sql_query` only runs SELECT statements, but the agent can also run Python. If a datasource is a production database that must not change, connect it in DB-GPT with a read-only account.
- While the ReAct agent works, dsh shows only "DB-GPT is analyzing…"; its plan and steps appear once it concludes.
- When the ReAct agent wants to ask you something, the plugin skips the question and DB-GPT continues with its own reading of the request. The skipped question is listed in the steps.
- The conversation view shows DB-GPT's charts as their SQL and data table, and does not display HTML reports; open the conversation on the DB-GPT web page for those. For a step that ran a single query, DB-GPT reports the rows but not the SQL text.
- Reusing dsh's API currently supports only dsh model providers that use a DeepSeek API key; for other providers, use "Separate".
- When reusing dsh with the model left blank, switching dsh's default model makes DB-GPT restart on the next query, and that query waits for startup (about 30 seconds). Changing the API key in dsh does the same.
- The plugin's runtime logs don't appear in dsh's terminal; when DB-GPT fails to start, use `/dbgpt` to see why.
