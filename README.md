# dsh-plugin-dbgpt

把 [DB-GPT](../DB-GPT) 接入 DeepSeek Harness（dsh）的插件。插件启用后，你在 dsh 里问到查数据、统计、对比、排名这类问题时，dsh 会主动把问题交给 DB-GPT。DB-GPT 负责读表结构、写 SQL、执行，再把说明、SQL 和结果表格交回 dsh。

## 它做什么

- **管理 DB-GPT 服务**：插件启用时自动启动 DB-GPT 网页服务（默认端口 5670），停用插件或退出 dsh 时自动停止。修改模型相关设置后会自动重启 DB-GPT。
- **给 dsh 两个工具**：
  - `dbgpt_list_databases`：列出 DB-GPT 里已接好的数据库。
  - `dbgpt_query`：对某个数据库提一个数据问题。同一个 dsh 对话里，对同一个库的追问会沿用 DB-GPT 的上下文。
- **`/dbgpt` 命令**：`/dbgpt` 或 `/dbgpt status` 查看 DB-GPT 状态，`/dbgpt restart` 重启。

数据源仍在 DB-GPT 自己的网页里添加和管理（`http://<服务器>:5670`），插件直接使用这些数据源。DB-GPT 的数据源和历史对话保存在 `DB-GPT/pilot/` 下，开关插件不会影响它们。

## 安装

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
| 模型来源 | **复用 dsh 的 API**：使用 dsh 当前模型提供方的地址和 API Key。**单独配置**：使用下面填写的地址、模型和 API Key。 |
| 模型名称 | 复用 dsh 时留空表示用 dsh 当前的默认模型；单独配置时必填。 |
| API 地址 | OpenAI 兼容地址（以 `/v1` 结尾）。单独配置时必填；复用 dsh 时可选，用来覆盖推算出的地址。 |
| API Key | 只在单独配置时出现。保存在 dsh 的凭据存储里（凭据名 `DBGPT_LLM_API_KEY`），不写进配置文件。 |
| Embedding 模型 / 地址 | DB-GPT 检索表结构和知识库时用。地址留空表示与模型相同。 |
| Embedding API Key | 保存在 dsh 的凭据存储里（凭据名 `DBGPT_EMBEDDING_API_KEY`）。没设置时用模型的 API Key。 |
| DB-GPT 目录 / 端口 | DB-GPT 项目路径和服务端口。 |

DB-GPT 通过 **OpenAI 兼容接口** 调用模型。复用 dsh 时，插件把 dsh 的地址换算成 OpenAI 兼容地址：结尾的 `/anthropic` 换成 `/v1`，比如 `https://api.deepseek.com/anthropic` → `https://api.deepseek.com/v1`。只能通过 Anthropic 协议调用的模型 DB-GPT 用不了，这时在“模型名称”里另填一个模型。

地址是 `api.deepseek.com` 时，插件让 DB-GPT 使用它自带的 DeepSeek 接入方式（`proxy/deepseek`），并关闭思考模式；否则 deepseek-v4-pro 会把输出额度花在思考上，DB-GPT 拿不到 SQL。其他地址使用通用的 `proxy/openai`。需要时可以用 YAML 字段 `llmProvider` 指定。

DeepSeek 官方 API 不提供 Embedding。DB-GPT 现有的向量数据是用京东云的 `text-embedding-3-large` 建的，所以 Embedding 地址填 `https://modelservice.jdcloud.com/v1`，Embedding API Key 填京东云的 key。

也可以直接改 YAML。设置页保存的值写在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dbgpt` 条目里；对所有 profile 生效的默认值在本目录的 `cordis.patch.yml`。全部字段及说明见 [`src/config.js`](src/config.js)，其中不在设置页里的有：

- `manage`（默认 `true`）：设为 `false` 时插件不启动 DB-GPT，而是连接 `endpoint` 指定的已有服务，此时必须设置 `llmModel` 为该服务里部署的模型名。
- `llmProvider`（默认 `auto`）：DB-GPT 的模型接入方式，可选 `proxy/openai`、`proxy/deepseek`。
- `llmApiKeyEnv`、`embeddingApiKeyEnv`：两个 API Key 的凭据名。
- `launcher`：启动命令，默认 `.venv/bin/dbgpt start webserver`。
- `bindHost`（默认 `0.0.0.0`）、`language`、`maxRows`（返回给模型的最多行数，默认 50）、`startupTimeoutMs`、`requestTimeoutMs`、`llmContextLength`。

插件每次启动 DB-GPT 时会生成配置文件 `/tmp/dsh-plugin-dbgpt/dbgpt-<端口>.toml`（不含密钥，密钥通过环境变量传给 DB-GPT）。DB-GPT 自己的日志仍在 `DB-GPT/logs/`。

## 开发

插件是纯 JavaScript（ESM），不需要构建，改完代码在插件页面把插件关掉再打开（或重启 dsh）即可生效。

| 文件 | 内容 |
| --- | --- |
| `src/index.js` | 插件入口：注册工具和 `/dbgpt` 命令，接上配置变化 |
| `src/config.js` | 配置项定义 |
| `src/launch.js` | 解析模型来源（复用 dsh / 单独配置）、生成 DB-GPT 配置 |
| `src/supervisor.js` | 启动、等待就绪、重启、停止 DB-GPT 进程 |
| `src/dbgpt-api.js` | 调用 DB-GPT 接口，解析它返回的 `<chart-view>` 结果 |
| `src/render.js` | 把结果转成给模型看的 Markdown |
| `src/client.js` | 网页端：插件页面里的设置表单 |
| `cordis.patch.yml` | 安装后加入 profile 的配置层 |
| `install.sh` | 新电脑一键安装 |

运行单元测试：

```sh
npm test
```

想加新工具（比如调用 DB-GPT 的其他对话模式）时，在 `src/index.js` 里照 `dbgpt_query` 的写法用 `defineTool` 注册即可；接口文档见 deepseek-harness 的 `docs/user/develop/`。

## 已知限制

- DB-GPT 执行的是模型生成的 SQL，插件不拦截写操作。如果数据源里有不能改动的生产库，请在 DB-GPT 里用只读账号连接。
- 复用 dsh 的 API 目前只支持 dsh 的 DeepSeek API Key 类型的模型提供方；其他类型请改用“单独配置”。
- 复用 dsh 且模型名称留空时，dsh 切换默认模型后，DB-GPT 会在下一次查询时自动重启，这次查询会多等启动时间（约 30 秒）。在 dsh 里改了 API Key 之后也一样。
- 插件的运行日志不会显示在 dsh 的终端里；DB-GPT 起不来时，用 `/dbgpt` 查看原因。
