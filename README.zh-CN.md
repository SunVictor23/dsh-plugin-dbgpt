# dsh-plugin-dbgpt

[English](README.md) | 中文

把 [DB-GPT](https://github.com/eosphoros-ai/DB-GPT) 接入 DeepSeek Harness（dsh）的插件。插件启用后，你在 dsh 里问到查数据、统计、对比、排名这类问题时，dsh 会主动把问题交给 DB-GPT。默认由 DB-GPT 的 ReAct 智能体负责分析：它自己规划、按需多次查询 SQL、修正出错的查询并写出结论，随后 dsh 根据该结论生成正式回复。

## 它做什么

- **管理 DB-GPT 服务**：插件启用时自动启动 DB-GPT 网页服务（默认端口 5670），停用插件或退出 dsh 时自动停止。修改模型相关设置后会自动重启 DB-GPT。
- **两种分析方式**，在设置里的 **分析方式** 选择：
  - **ReAct 智能体**（默认）：DB-GPT 的数据智能体读取表结构、制定计划、执行 SQL 查询（能并行时一次查多条）、画图、修正并重跑出错的查询，最后写出结论；随后 dsh 根据该结论生成正式助手回复。展开工具结果行，可以看到 DB-GPT 的计划和每一步的思路、SQL 和查到的数据。
  - **单轮 SQL**：每次调用让 DB-GPT 写一条 SQL 并返回结果行，由 dsh 的模型根据结果继续思考和追问。
- **给 dsh 的工具和命令**：见 [工具](#工具)。

数据源仍在 DB-GPT 自己的网页里添加和管理（`http://<服务器>:5670`），插件直接使用这些数据源。DB-GPT 的数据源和历史对话保存在 `DB-GPT/pilot/` 下，开关插件不会影响它们。

## 工具

问题需要查数据时，dsh 的模型会自己调用这些工具。`dbgpt_list_databases` 始终可用；两个提问工具中，dsh 只会拿到当前分析方式对应的那一个。

| 工具 | 适用方式 | 作用 | 参数 | 返回 |
| --- | --- | --- | --- | --- |
| `dbgpt_list_databases` | 两种方式都有 | 列出 DB-GPT 里已接好的数据库。dsh 不知道数据在哪个库时会先调用它。 | 无 | 每个数据库的名称、类型和描述 |
| `dbgpt_agent` | **ReAct 智能体**方式（默认） | 把问题交给 DB-GPT 的 ReAct 数据智能体：它自己规划、按需多次执行 SQL 查询、修正出错的查询、画图，最后写出结论。随后 dsh 根据该结论回复用户。一次分析最长 900 秒。 | `database`：`dbgpt_list_databases` 列出的库名；`question`：用户的原始问题 | DB-GPT 的结论、计划，以及每一步的思路、SQL 和查到的数据 |
| `dbgpt_query` | **单轮 SQL** 方式 | 让 DB-GPT 对一个数据库写一条 SQL 并执行，由 dsh 的模型根据结果继续思考。 | `database`：`dbgpt_list_databases` 列出的库名；`question`：一个完整、独立的问题 | DB-GPT 的说明、SQL、结果行数、前 `maxRows` 行结果（默认 50），以及 DB-GPT 建议的图表类型 |

同一个 dsh 对话里，对同一个数据库的追问会接着 DB-GPT 的同一个对话，DB-GPT 能看到之前的问题和结论。两种分析方式各自使用独立的 DB-GPT 对话。

插件还提供一个在 dsh 里输入的命令：

| 命令 | 作用 |
| --- | --- |
| `/dbgpt` 或 `/dbgpt status` | 显示 DB-GPT 的运行状态、分析方式、DB-GPT 使用的模型、DB-GPT 网页地址和目录；DB-GPT 启动失败时还会显示原因 |
| `/dbgpt restart` | 重启插件管理的 DB-GPT 服务 |

## 安装

Host 集成兼容两套 DSH 结构化错误包布局：存在拆分后的 `@deepseek-ai/dsh-error` 时优先使用它，较早布局则回退到 `@deepseek-ai/dsh-llm` 导出的 `HarnessError`。两个 peer 都声明为可选，因为一套受支持的 DSH 通常只提供其中一个。

### 一键安装（新电脑推荐）

把本目录拷到新电脑上，执行：

```sh
bash install.sh
```

脚本会依次：

1. 检查 git、Node.js（≥ 24.9）、pnpm、uv，缺 pnpm 或 uv 时自动安装；
2. DB-GPT 目录不存在就从 GitHub 克隆（固定到测试过的版本），然后 `uv sync` 安装依赖；如果带来了旧电脑的 `pilot/`，把指向旧路径的 SQLite 数据源改到新路径；
3. deepseek-harness 目录不存在就克隆，然后 `pnpm install` 和 `pnpm run build`；
4. 把本机的 DB-GPT 路径、端口、Embedding 地址写进本目录的 `cordis.patch.yml`；
5. 把插件装进 dsh 的 `web` profile；
6. 询问 DeepSeek API Key 和 Embedding API Key（直接回车跳过），存到 `~/.dsh/.env`（权限 600）。也可以事先用同名环境变量 `DEEPSEEK_API_KEY`、`DBGPT_EMBEDDING_API_KEY` 传入。

默认 DB-GPT 和 deepseek-harness 放在本目录的上一级，即与 `dsh-plugin-dbgpt` 并列。目录不同时用参数指定：

```sh
bash install.sh --dbgpt-dir /data/DB-GPT --dsh-dir /data/deepseek-harness
```

其他参数：`--port` 改 DB-GPT 端口，`--embedding-url none` 让 Embedding 跟模型用同一个地址，`--skip-build` 跳过依赖安装和构建，`--no-keys` 不询问 Key，`--profile` 装到别的 dsh profile。脚本可以重复执行，已完成的步骤不会出问题。完整说明见 `bash install.sh --help`。

装完后启动 dsh：`cd deepseek-harness && pnpm dsh web`。插件会自动启动 DB-GPT。

旧电脑的 DB-GPT 数据源和历史对话都在 `DB-GPT/pilot/` 里，想保留就在运行脚本前把它拷到新电脑的 DB-GPT 目录。Key 保存在每台电脑自己的 dsh 里，不会随插件迁移；以后在 dsh 网页里保存的 Key 优先于 `~/.dsh/.env`。

### 手动安装

在 deepseek-harness 目录执行（dsh 从源码运行时用 `pnpm dsh`）：

```sh
pnpm dsh plugin --profile web add /mnt/workspace/sxk_dbgpt/dsh-plugin-dbgpt
```

也可以在 dsh 网页的 **插件 → 添加插件** 里填这个目录的绝对路径。安装后重启 dsh web 生效。

前提：DB-GPT 已经用 `uv sync` 装好依赖，`DB-GPT/.venv/bin/dbgpt` 存在；`cordis.patch.yml` 里的 `dbgptHome` 是本机的 DB-GPT 路径。

## 开关插件

在 dsh 网页的 **插件** 页面找到 `dsh-plugin-dbgpt`，用开关启用或停用。停用时 DB-GPT 服务随之停止，dsh 也不再看到这两个工具；之前保存的设置保留在 profile 里，再次启用时直接沿用。

## 设置

在 **插件** 页面打开 `dsh-plugin-dbgpt`，点 `dbgpt` 这一行的 **配置**。

| 设置 | 说明 |
| --- | --- |
| 分析方式 | **ReAct 智能体**（默认）：DB-GPT 自己规划、按需多次查询并写出结论，dsh 根据结论回复。**单轮 SQL**：DB-GPT 每次只执行一条查询，由 dsh 的模型根据结果思考。从 dsh 的下一步开始生效。 |
| 模型来源 | **复用 dsh 的 API**：使用 dsh 当前模型提供方的地址和 API Key。**单独配置**：使用下面填写的地址、模型和 API Key。 |
| 模型名称 | 复用 dsh 时留空表示用 dsh 当前的默认模型；单独配置时必填。 |
| API 地址 | OpenAI 兼容地址（以 `/v1` 结尾）。单独配置时必填；复用 dsh 时可选，用来覆盖推算出的地址。 |
| API Key | 只在单独配置时出现。保存在 dsh 的凭据存储里（凭据名 `DBGPT_LLM_API_KEY`），不写进配置文件。 |
| Embedding 模型 / 地址 | DB-GPT 检索表结构和知识库时用。地址留空表示与模型相同。 |
| Embedding API Key | 保存在 dsh 的凭据存储里（凭据名 `DBGPT_EMBEDDING_API_KEY`）。没设置时用模型的 API Key。 |
| DB-GPT 目录 / 端口 | DB-GPT 项目路径和服务端口。 |

DB-GPT 通过 **OpenAI 兼容接口** 调用模型。复用 dsh 时，插件把 dsh 的地址换算成 OpenAI 兼容地址：结尾的 `/anthropic` 换成 `/v1`，比如 `https://api.deepseek.com/anthropic` → `https://api.deepseek.com/v1`。只能通过 Anthropic 协议调用的模型 DB-GPT 用不了，这时在“模型名称”里另填一个模型。

地址是 `api.deepseek.com` 时，插件让 DB-GPT 使用它自带的 DeepSeek 接入方式（`proxy/deepseek`），并关闭思考模式；否则 deepseek-v4-pro 会把输出额度花在思考上，DB-GPT 拿不到 SQL。其他地址使用通用的 `proxy/openai`。需要时可以用 YAML 字段 `llmProvider` 指定。ReAct 智能体靠模型的工具调用（function calling）推进每一步，所以这种方式下 DB-GPT 用的模型必须支持工具调用；DeepSeek 的模型都支持。

DeepSeek 官方 API 不提供 Embedding。DB-GPT 现有的向量数据是用京东云的 `text-embedding-3-large` 建的，所以 Embedding 地址填 `https://modelservice.jdcloud.com/v1`，Embedding API Key 填京东云的 key。

也可以直接改 YAML。设置页保存的值写在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dbgpt` 条目里；对所有 profile 生效的默认值在本目录的 `cordis.patch.yml`。全部字段及说明见 [`src/config.js`](src/config.js)，其中不在设置页里的有：

- `manage`（默认 `true`）：设为 `false` 时插件不启动 DB-GPT，而是连接 `endpoint` 指定的已有服务，此时必须设置 `llmModel` 为该服务里部署的模型名。
- `llmProvider`（默认 `auto`）：DB-GPT 的模型接入方式，可选 `proxy/openai`、`proxy/deepseek`。
- `llmApiKeyEnv`、`embeddingApiKeyEnv`：两个 API Key 的凭据名。
- `launcher`：启动命令，默认 `.venv/bin/dbgpt start webserver`。
- `bindHost`（默认 `0.0.0.0`）、`language`、`startupTimeoutMs`、`llmContextLength`。
- `agentTimeoutMs`（默认 960000）：一次 ReAct 智能体分析的时限。DB-GPT 自己会在 900 秒或 60 轮后停止智能体。
- `requestTimeoutMs`（默认 300000）和 `maxRows`（返回给模型的最多行数，默认 50）：只用于单轮 SQL 方式。

插件每次启动 DB-GPT 时会生成配置文件 `/tmp/dsh-plugin-dbgpt/dbgpt-<端口>.toml`（不含密钥，密钥通过环境变量传给 DB-GPT）。DB-GPT 自己的日志仍在 `DB-GPT/logs/`。

## 开发

插件是纯 JavaScript（ESM），不需要构建，改完代码在插件页面把插件关掉再打开（或重启 dsh）即可生效。

| 文件 | 内容 |
| --- | --- |
| `src/index.js` | 插件入口：注册工具和 `/dbgpt` 命令，接上配置变化 |
| `src/config.js` | 配置项定义 |
| `src/launch.js` | 解析模型来源（复用 dsh / 单独配置）、生成 DB-GPT 配置 |
| `src/supervisor.js` | 启动、等待就绪、重启、停止 DB-GPT 进程 |
| `src/dbgpt-api.js` | 调用 DB-GPT 接口：单轮 SQL 的回答（解析其中的 `<chart-view>` 结果）和 ReAct 智能体的分析（把事件流整理成计划、步骤和结论） |
| `src/render.js` | 把结果转成给模型看的 Markdown，把智能体的步骤转成对话视图里显示的 Markdown |
| `src/client.js` | 网页端：插件页面里的设置表单，以及对话里 `dbgpt_agent` 的显示视图 |
| `cordis.patch.yml` | 安装后加入 profile 的配置层 |
| `install.sh` | 新电脑一键安装 |

运行单元测试：

```sh
npm test
```

想加新工具（比如调用 DB-GPT 的其他对话模式）时，在 `src/index.js` 里照 `dbgpt_query` 的写法用 `defineTool` 注册即可；接口文档见 deepseek-harness 的 `docs/user/develop/`。

## 已知限制

- 单轮 SQL 方式下，DB-GPT 执行的是模型生成的 SQL，插件不拦截写操作。ReAct 智能体的 `sql_query` 只执行 SELECT，但智能体还能运行 Python。如果数据源里有不能改动的生产库，请在 DB-GPT 里用只读账号连接。
- ReAct 智能体分析期间，dsh 只显示“DB-GPT 正在分析中…”，计划和步骤要等它得出结论后才显示。
- ReAct 智能体想向你提问时，插件会跳过这个问题，DB-GPT 按自己的理解继续。被跳过的问题会列在步骤里。
- 对话视图把 DB-GPT 的图表显示为它的 SQL 和数据表，也不显示 HTML 报告；需要时请到 DB-GPT 网页打开这次对话。只执行了一条查询的步骤，DB-GPT 只返回结果行，不返回 SQL 原文。
- 复用 dsh 的 API 目前只支持 dsh 的 DeepSeek API Key 类型的模型提供方；其他类型请改用“单独配置”。
- 复用 dsh 且模型名称留空时，dsh 切换默认模型后，DB-GPT 会在下一次查询时自动重启，这次查询会多等启动时间（约 30 秒）。在 dsh 里改了 API Key 之后也一样。
- 插件的运行日志不会显示在 dsh 的终端里；DB-GPT 起不来时，用 `/dbgpt` 查看原因。
