# dsh-plugin-dbgpt

[中文](README.md) | English

A DeepSeek Harness (dsh) plugin that connects [DB-GPT](https://github.com/eosphoros-ai/DB-GPT). With the plugin enabled, when you ask dsh to look up data, count, compare, or rank, dsh hands the question to DB-GPT on its own. DB-GPT reads the table schemas, writes the SQL, runs it, and returns the explanation, the SQL, and the result table to dsh.

## What it does

- **Manages the DB-GPT server**: enabling the plugin starts the DB-GPT web server (port 5670 by default); disabling the plugin or quitting dsh stops it. Changing a model setting restarts DB-GPT automatically.
- **Gives dsh two tools**:
  - `dbgpt_list_databases`: lists the databases already connected in DB-GPT.
  - `dbgpt_query`: asks one database a data question. Follow-up questions about the same database in the same dsh conversation keep DB-GPT's context.
- **`/dbgpt` command**: `/dbgpt` or `/dbgpt status` shows DB-GPT's status; `/dbgpt restart` restarts it.

Datasources are still added and managed on DB-GPT's own web page (`http://<server>:5670`), and the plugin uses them as they are. DB-GPT keeps its datasources and chat history under `DB-GPT/pilot/`; turning the plugin on or off leaves them alone.

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
| Model source | **Reuse dsh's API**: use the URL and API key of dsh's current model provider. **Separate**: use the URL, model, and API key entered below. |
| Model | When reusing dsh, leave blank to use dsh's current default model. Required when separate. |
| API URL | OpenAI-compatible URL (ending in `/v1`). Required when separate; when reusing dsh, optional and replaces the derived URL. |
| API key | Shown only when separate. Stored in dsh's credential store (credential name `DBGPT_LLM_API_KEY`), never in a configuration file. |
| Embedding model / URL | Used by DB-GPT to retrieve table schemas and knowledge bases. Leave the URL blank to use the model's. |
| Embedding API key | Stored in dsh's credential store (credential name `DBGPT_EMBEDDING_API_KEY`). While it is unset, the model's API key is used. |
| DB-GPT directory / Port | Path of the DB-GPT project and the server port. |

DB-GPT calls models through the **OpenAI-compatible API**. When reusing dsh, the plugin converts dsh's URL to an OpenAI-compatible one by replacing a trailing `/anthropic` with `/v1`, for example `https://api.deepseek.com/anthropic` → `https://api.deepseek.com/v1`. DB-GPT can't use a model served only over the Anthropic API; in that case name another model under "Model".

When the URL is `api.deepseek.com`, the plugin has DB-GPT use its built-in DeepSeek integration (`proxy/deepseek`) with thinking mode off. Otherwise deepseek-v4-pro spends its output budget on thinking and DB-GPT gets no SQL back. Other URLs use the generic `proxy/openai`. The YAML field `llmProvider` sets it explicitly if needed.

The official DeepSeek API serves no embeddings. The vector data in this DB-GPT setup was built with JD Cloud's `text-embedding-3-large`, so the embedding URL is `https://modelservice.jdcloud.com/v1` and the embedding API key is a JD Cloud key.

You can also edit the YAML directly. Values saved from the settings page go into the `dbgpt` entry of `~/.dsh/profiles/web/cordis.patch.yml`; defaults for every profile are in this directory's `cordis.patch.yml`. All fields are described in [`src/config.js`](src/config.js). Those not on the settings page:

- `manage` (default `true`): when `false`, the plugin doesn't start DB-GPT and connects to the existing server at `endpoint` instead. `llmModel` must then name a model deployed in that server.
- `llmProvider` (default `auto`): how DB-GPT reaches the model, `proxy/openai` or `proxy/deepseek`.
- `llmApiKeyEnv`, `embeddingApiKeyEnv`: credential names of the two API keys.
- `launcher`: start command, `.venv/bin/dbgpt start webserver` by default.
- `bindHost` (default `0.0.0.0`), `language`, `maxRows` (most rows returned to the model, default 50), `startupTimeoutMs`, `requestTimeoutMs`, `llmContextLength`.

Each time the plugin starts DB-GPT, it writes the config file `/tmp/dsh-plugin-dbgpt/dbgpt-<port>.toml`. The file holds no secrets; the keys reach DB-GPT through environment variables. DB-GPT's own logs are still in `DB-GPT/logs/`.

## Development

The plugin is plain JavaScript (ESM) with no build step. After changing the code, turn the plugin off and on again on the Plugins page (or restart dsh).

| File | Contents |
| --- | --- |
| `src/index.js` | Plugin entry: registers the tools and the `/dbgpt` command, follows configuration changes |
| `src/config.js` | Configuration fields |
| `src/launch.js` | Resolves the model source (reuse dsh / separate) and generates DB-GPT's configuration |
| `src/supervisor.js` | Starts DB-GPT, waits until it is ready, restarts and stops it |
| `src/dbgpt-api.js` | Calls the DB-GPT API and parses the `<chart-view>` results it returns |
| `src/render.js` | Turns results into Markdown for the model |
| `src/client.js` | Web side: the settings form on the Plugins page |
| `cordis.patch.yml` | Configuration layer added to the profile on install |
| `install.sh` | One-step install on a new machine |

Run the unit tests:

```sh
npm test
```

To add a tool (say, one that uses another DB-GPT chat mode), register it with `defineTool` in `src/index.js` the way `dbgpt_query` is. The API docs are in deepseek-harness's `docs/user/develop/`.

## Known limitations

- DB-GPT runs the SQL the model generates, and the plugin doesn't block writes. If a datasource is a production database that must not change, connect it in DB-GPT with a read-only account.
- Reusing dsh's API currently supports only dsh model providers that use a DeepSeek API key; for other providers, use "Separate".
- When reusing dsh with the model left blank, switching dsh's default model makes DB-GPT restart on the next query, and that query waits for startup (about 30 seconds). Changing the API key in dsh does the same.
- The plugin's runtime logs don't appear in dsh's terminal; when DB-GPT fails to start, use `/dbgpt` to see why.
