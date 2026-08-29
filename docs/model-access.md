# 模型接入指南

本文讲清三件事:用哪条通道接模型、怎么验证一个 provider 能不能用、怎么加一家新的 provider。
后端默认 provider 的密钥只放环境变量；浏览器里由用户填写的 key 只存在当前浏览器 `localStorage`，
随本轮请求交给本机后端，用完即弃，不写配置、日志或台账。

## 1. 两条通道

| 通道 | 适用 | 怎么配 | 说明 |
|---|---|---|---|
| ChatGPT 订阅登录(默认) | OpenAI 模型,Plus / Pro / Team 订阅 | “接入 AI”→“订阅接入”→“登录 Codex” | 产品打开 OpenAI 官方登录页；登录态存在**产品自己的 CODEX_HOME**,与 `~/.codex` 隔离;不需要任何 API key |
| Claude.ai 订阅登录 | 本机 Claude Code 已安装并登录 | 在 Claude Code 里完成 `/login`，设置页自动检测 | 复用本机订阅；调用时强制关闭本地工具、MCP、联网搜索工具、插件与 CLI 会话落盘 |
| API key | OpenAI 或第三方(DeepSeek / 通义千问 / 智谱 GLM / Kimi …) | 浏览器“接入 AI”填写，或 `export <ENV_KEY>=...` + `--provider <id>` | 浏览器 key 只走本轮内存；命令行/后端默认 key 从模板声明的环境变量读取 |

设置页的订阅卡片不是静态开关。后端会实时检测 Codex / Claude Code 的 CLI、版本与登录状态。
Codex 未登录时会显示“登录 Codex”：点击后由产品使用自己的 `CODEX_HOME` 启动官方 `codex login`，
浏览器授权完成后页面自动轮询并点亮；登录失败或超时会明确提示重试。Qwen Code 的旧免费 OAuth 已停止，
DeepSeek CLI 也使用 API key，因此二者不列为
“免 key 订阅”。当前没有能同时证明“复用订阅”与“彻底禁用本地工具”的安全适配器时，不会照搬
Open Design 的自动批准参数后把按钮点亮。

### 从全新版本接入 ChatGPT 订阅

1. 启动本地 API 与浏览器 UI，进入左侧“接入 AI”。
2. 选择“订阅接入”，在 Codex 卡片点击“登录 Codex”。
3. 在自动打开的 OpenAI 官方页面由用户本人完成登录。产品不接触账号密码，也不会复用 `~/.codex` 的登录态。
4. 返回设置页等待状态变为“已登录”，点击“测试并保存”。只有真实对话探针成功后，订阅配置才会保存。
5. 若浏览器没有自动打开，可在仓库根使用后备命令：

```bash
CODEX_HOME="$(pwd)/.local/codex-home" codex login
```

设置页会实时检测这个产品专用登录态，无需重启或手工复制认证文件。

auth 的解析规则:用户没在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写过 auth 时,切换到第三方 profile 会自动用模板唯一支持的 `api_key`;显式写过的永不被覆盖(不支持就报错,不静默降级)。产品配置 `vibe-research.config.json` 里的 auth 只是产品默认,不算显式。

## 2. 从全新版本接入第三方模型

普通用户不需要先写环境变量：进入“接入 AI”→“API 接入”，选择供应商，填写 API 地址、模型名与
key，然后点击“测试并保存”。页面会先通过本机后端向所选供应商发起一次真实对话；成功才保存，失败
则保留当前已生效配置并显示可行动提示。保存后，首页 Agent、每日复盘、回测与研究页面共用这份配置。

下面的命令行流程用于开发者跑完整兼容矩阵：

```bash
# 1) 密钥只放环境变量(变量名见模板 env_key;此处以 DeepSeek 为例)
export DEEPSEEK_API_KEY=...
# 2) 先跑 10 项兼容矩阵(结果在 .local/provider-matrix/deepseek/<时间>/summary.md,不含密钥)
node orchestrator/src/finance/provider_matrix.ts --provider deepseek --model deepseek-v4-flash
# 3) 矩阵可接受后用于研究(或写进 .local/config.json)
node orchestrator/src/run.ts --symbol 300308 --market SZ --provider deepseek --model deepseek-v4-flash --python "$(pwd)/.venv/bin/python" < /dev/null
```

`.local/config.json` 写法:

```json
{ "provider": { "profile": "deepseek" }, "defaults": { "model": "deepseek-v4-flash" } }
```

优先级:`.local/config.json` ← 环境变量 `VRA_PROVIDER` / `VRA_PROVIDER_AUTH` ← CLI `--provider` / `--auth`。环境变量层整体生效(`VRA_PROVIDER` 与 `VRA_CODEX_HOME` / `VRA_PYTHON` 等可同时用)。

### 🔴 只能是 Responses 协议 —— `wire_api="chat"` 已被引擎彻底移除

引擎(`codex-rs/model-provider-info`)对 `wire_api = "chat"` **直接硬报错**。所以模板里没有、也不可能再有 chat 协议的 provider:
一家厂商要接进来,**必须自己提供 OpenAI 兼容的 `/responses` 端点**,或者你在中间架一个 Responses→Chat Completions 的网关
(那时填 `responses_support: "gateway"`,`base_url` 指向网关)。契约层在选用时就会拒掉 chat 并把这两条出路写在报错里,
不会让你配到跑起来才炸。

内置模板与对应环境变量(**均为 responses 协议**,供应商信息核实于 2026-08-26):

| id | 厂商 / 通道 | env_key | 默认模型 | base_url |
|---|---|---|---|---|
| `openai` | OpenAI 官方(订阅登录或 API key) | `OPENAI_API_KEY` | 引擎默认 | null(官方端点) |
| `deepseek` | DeepSeek 官方 Responses | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` | `https://api.deepseek.com` |
| `qwen` | 通义千问 · 阿里云百炼 | `DASHSCOPE_API_KEY` | `qwen3.8-max` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `glm` | 智谱 GLM · 阿里云百炼 | `DASHSCOPE_API_KEY` | `glm-5.2` | 同上 |
| `kimi` | Kimi · 阿里云百炼 | `DASHSCOPE_API_KEY` | `kimi-k2.7-code` | 同上 |
| `mimo` | 小米 MiMo 官方原生 Responses | `MIMO_API_KEY` | `mimo-v2.5` | `https://token-plan-cn.xiaomimimo.com/v1` |
| `selfhosted` | **自托管模型**（vLLM / SGLang / LM Studio / Ollama 等） | `SELFHOSTED_API_KEY` | 自己填 | `http://{Host}:{Port}/v1`（占位，必须复制覆盖） |

⚠️ **三个百炼模板不能直接用**:`base_url` 里的 `{WorkspaceId}` 是留给你填的。把模板复制到 `.local/providers/<id>.json`、
换成自己的工作空间 ID 再选用 —— 没换会在**选用时当场被拒**(而不是把密钥发到一个不存在的主机上)。
走百炼而不是各家官方端点,是因为截至核实日只有 DeepSeek 官方提供原生 `/responses`;智谱官方开放平台没有,
月之暗面官方是否提供未核实 —— 未核实的事不写成事实。

模板里的 `default_model` / `context_limit_tokens` 是易变的供应商信息,`verified_at` 记最近一次人工核实日期(null = 未核实);模型名下线时请显式 `--model`。

### 一个模板可以声明"它不支持服务端 schema"

`structured_output` 字段(缺省 `json_schema`):

- `json_schema` —— 支持 `text.format.type=json_schema`,产品照常硬传(OpenAI / DeepSeek 走这条)。
- `prompt` —— **不支持**。产品会把 schema 写进提示词,不再硬传。
  硬传的后果不是降级而是**整轮被拒**:阶段直接 failed。

🔴 为什么这条降级不算放松要求:**`outputSchema` 从来就不是校验边界**。产物合不合规是产品自己校验的
(阶段过 validator、导入草稿过 `parseOutput`)。降级损失的是**命中率**——模型少了一层硬约束、
可能更容易写歪、重试次数上升;但写歪了照样过不了产品这关。所以这条降级**不能**顺手把校验也一起省掉。

## 3. 兼容矩阵怎么读

`provider_matrix.ts` 用 Codex SDK 对目标 provider 真跑 10 个小回合,机器判定 pass / partial / fail / n/a / error;临时目录 cwd、workspace-write、无网络、不加载产品宪法(只测协议兼容,不测研究纪律)。

| # | 项目 | pass 的判据 | 非 pass 的含义 |
|---|---|---|---|
| ① | 单次文本 | 回复含约定 token | 基本对话不通 |
| ② | 单工具调用 | 至少 1 条命令且输出含约定串 | 不会调用工具 |
| ③ | 连续三轮工具调用 | step-A / B / C 出自不同命令项且按序 | partial = 合并成一条或乱序 |
| ④ | 并行工具调用 | 两条命令都执行且事件流观察到同时在途 | partial = 都执行但串行 |
| ⑤ | 工具失败自修复 | 先失败 → 修复命令 → 最终回复说明 | partial = 修了没说 / 没修 |
| ⑥ | 长流 | 1–200 行编号一个不缺 + turn.completed | partial = 流被截断 |
| ⑦ | reasoning item | 事件里出现 reasoning 项 | partial = 模型不回传推理摘要(不算 fail) |
| ⑧ | schema 严格输出 | outputSchema 下最终回复为合法 JSON 且字段齐 | fail = 不是 JSON |
| ⑨ | 多轮上下文延续 | 第二回合复述第一回合约定词 | 会话不连续 |
| ⑩ | 无 previous_response_id 协议下的延续 | 非 responses 协议时 ⑨ 通过即 pass | responses 协议记 n/a(由 Codex 内部处理)——目前所有模板都是 responses,故此项恒为 n/a |

判定口径(含 ④ 如何用 `item.started/completed` 交错证明并发、⑦ 为什么要 `model_reasoning_summary=detailed`)见 `orchestrator/src/finance/provider_matrix.ts` 头注释;`judge()` 有逐项正反单测。结果文件落盘前做两层脱敏(provider 密钥精确替换 + 通用 token / 签名 URL)。矩阵不全绿的 provider 只应用于试验;编排器会把 provider 与矩阵状态写进运行的 `manifest.json`。

OpenAI 基线(2026-08-22,订阅登录,引擎默认模型):9 pass · 1 n/a。

**小米 MiMo 实测(2026-08-26,`mimo-v2.5`,API key)**:pass 7 · partial 1 · error 1 · n/a 1。

| 项 | 结果 | 说明 |
|---|---|---|
| ①②③④⑤⑥⑨ | pass | 文本 / 单工具 / 三轮工具 / **并行工具(峰值 2)** / 失败自修复 / 200 行长流 / 多轮延续 |
| ⑦ reasoning | partial | `mimo-v2.5` 不回传;⚠️ 换 `mimo-v2.5-pro` 直连实测**有** —— 这项跟**模型**走,不跟 provider 走 |
| ⑧ schema | **error** | `responses_feature_not_supported:text.format type 'json_schema' is not supported, only 'text' and 'json_object' are allowed` |
| ⑩ | n/a | responses 协议不适用 |

⑧ 是**协议层的事实**,矩阵如实记着不粉饰;产品侧用 `structured_output: "prompt"` 绕开了它。
同日用 `mimo-v2.5` 真跑了一个完整研究阶段(profile):**validator 通过、79 条证据**,
agent 那一轮 4.7 分钟 —— ⚠️ 慢,turn 超时压到 5 分钟会连续两次超时,用默认 20 分钟。

### 发布前从零接入实测（2026-08-28）

- **Codex 订阅**：产品专用 `.local/codex-home` 从未登录状态开始，在设置页点击“登录 Codex”，
  成功打开 OpenAI 官方授权页；用户完成授权后，页面自动从“等待授权”变为“可用”。随后
  “测试并保存”真实对话通过，并在“每日复盘”完成一份完整当日复盘。最终配置为
  `provider=cli-codex`，没有 API key，也没有读取或覆盖 `~/.codex`。
- **MiMo API**：清空浏览器模型配置后，从“API 接入”重新选择 MiMo，填写官方 base URL、
  `mimo-v2.5-pro` 与用户自己的 key；“测试并保存”真实对话通过，随后同样在“每日复盘”完成完整报告。
  key 未写入仓库、后端配置、运行账本或日志。实测结束后已把默认接入恢复为 Codex 订阅。
- **失败保护**：新配置只有在真实对话成功后才保存；失败不会覆盖当前已生效配置。订阅登录任务限制为
  单实例并带超时与整组进程清理，重复点击不会启动多个登录流程。

这次验证的是普通用户真实路径，不是只调用 provider 矩阵或后端函数：从无配置/未登录状态开始，
经过浏览器设置页接入，再在实际业务页面发起 Agent 任务。

## 3. 自托管模型（私有化部署：vLLM / SGLang / LM Studio / Ollama）

私有化场景走 `selfhosted` 占位模板。完整路径（与云厂商模板机制完全相同，只是端点在内网）：

1. **复制占位模板到用户覆盖层**，替换占位符：

   ```bash
   cp providers/selfhosted.json .local/providers/selfhosted.json
   # 编辑 .local/providers/selfhosted.json:
   #   base_url      -> http://192.168.x.x:8000/v1   (你的推理端点;http 合法,自托管不受 https 约束)
   #   default_model -> 你部署的模型名 (如 qwen3-32b)
   #   responses_support / known_incompatibilities 按端点实际情况修正
   ```

   不复制、直接选用 `selfhosted` 会被当场拒（占位符未替换）——和百炼三件套同一护栏。

2. **选产品 provider**（研究 / 多空辩论 / 回测 / 每日复盘等编排引擎用的这一层）：

   ```jsonc
   // .local/config.json
   { "provider": { "profile": "selfhosted", "auth": "api_key" },
     "defaults": { "model": "qwen3-32b" } }
   ```

   或在启动服务的 shell 里 `export VRA_PROVIDER=selfhosted VRA_MODEL=...`。

3. **密钥只走环境变量**：`export SELFHOSTED_API_KEY=...`。⚠️ 最常见的私有化故障：
   重启编排器进程时没带这个环境变量 → 引擎报"provider.auth=api_key 但环境变量
   SELFHOSTED_API_KEY 未设置"，界面表现为"所有阶段都失败了：根本没跑起来"。
   用 launchd / systemd 托管时把 `SELFHOSTED_API_KEY` 写进服务环境（plist / Environment），
   不要写进任何仓库文件或 `.local/config.json`。

4. **`/v1/responses` 不可用怎么办**：多数 vLLM 版本的 `/v1/responses` 对 codex 的复杂
   请求（含 `developer` 角色 / reasoning 项）报 400。模板 `responses_support` 默认 `gateway`
   即指这条出路：在端点和产品之间架一层 Responses→Chat Completions 转换网关
   （LiteLLM、one-api、自研代理均可），`base_url` 指向网关。端点原生支持
   `/v1/responses` 时改 `responses_support: "native"`。
   自研 adapter 不在本仓库范围，`gateway` 字段就是给这类部署留的位置。

5. **跑兼容矩阵回填**：`node orchestrator/src/finance/provider_matrix.ts --provider selfhosted`，
   按结果更新 `.local/providers/selfhosted.json` 的 `matrix` 段。矩阵不全绿只用于试验。

**设置页"API 接入" ≠ 产品 provider**：设置页保存的模型配置（浏览器 localStorage，
随请求发给本机后端）只作用于自由对话 / "问 Agent" 通道；个股研究、多空辩论、回测、
每日复盘走的是 `.local/config.json` 的产品级 provider。私有化部署两边要分别接好——
只配设置页会出现"能聊天但研究/辩论根本没跑起来"的假象。

## 4. 加一家新的 provider

1. 复制 `providers/deepseek.json` 为 `providers/<id>.json`(或放用户私有覆盖 `.local/providers/<id>.json`,同结构,优先级更高);`id` 小写字母开头,只含 `a-z0-9_-`,且与文件名一致。
2. 填字段:`name`、`wire_api`(**只能 `responses`**;`chat` 会被当场拒绝,见上文)、`base_url`(**第三方必须显式 https**——Codex 对空 base_url 会回退到 `api.openai.com`,密钥会发到错误主机)、`env_key`(大写变量名,不得是 HOME / PATH 等受保护名)、`auth_modes`(第三方只能 `["api_key"]`)、`requires_openai_auth: false`、`default_model`、`responses_support`(厂商自己提供 `/responses` 填 `native`,经自建网关转换填 `gateway`;不能填 `none`)。可选:`query_params` / `http_headers` / `env_http_headers`(值是环境变量名)/ `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` / `context_limit_tokens` / `retryable_errors` / `known_incompatibilities` / `verified_at`。
3. `http_headers` / `query_params` 里写了像密钥的值会被直接拒绝——密钥只能经 `env_key` / `env_http_headers` 引用。
4. 跑矩阵,按结果回填 `matrix.status` / `matrix.results` / `matrix.note`。

模板怎么映射到 Codex:非 openai 的 profile 注入 `model_provider=<id>` + `model_providers.<id>={name, base_url, env_key, wire_api, requires_openai_auth=false, …}`(经 SDK 配置覆盖,不写 `~/.codex`);进程环境只透传 `env_key` 与 `env_http_headers` 引用的变量(openai 的 api_key 模式另设 `CODEX_API_KEY`);agent 的 shell 命令不继承任何密钥类变量。

## 5. 常见问题

- **`--provider deepseek` 报"环境变量 DEEPSEEK_API_KEY 未设置"**:密钥只从环境变量读,先 `export`。
- **重启编排器后研究/辩论/回测全报"所有阶段都失败了:根本没跑起来",但"问 Agent"能聊**:
  设置页的 API 接入只覆盖自由对话通道;编排引擎走 `.local/config.json` 的产品级 provider。
  九成是重启时进程环境丢了 `env_key` 对应的变量(见 §3 自托管第 3 条),或产品 provider
  还指向未登录的 `openai` 模板。`GET /product`(带 Bearer token)可看当前产品 provider 解析结果。
- **报"provider xxx 不支持 auth=chatgpt_login"**:你在 `.local/config.json` / `VRA_PROVIDER_AUTH` / `--auth` 显式写了 chatgpt_login;第三方只能 api_key,改掉或删掉显式设置即可。
- **⑦ partial**:该模型 / 协议不回传推理摘要,不影响研究运行。
- **④ partial**:provider 把同一回合的多条工具调用串行执行,功能可用但慢。
- **⑩ n/a**:responses 协议下 previous_response_id 由 Codex 内部处理,此项不适用(所有模板都是 responses)。
- **报"引擎不再支持 wire_api=\"chat\""**:你在用一份旧模板。改成厂商的 Responses 端点,或架一个 Responses→Chat 网关并填 `responses_support: "gateway"`。
- **报"base_url 里还有没替换的占位符 {WorkspaceId}"**:百炼三件套要填自己的工作空间 ID,把模板复制到 `.local/providers/<id>.json` 改完再用。
- **想用 OpenAI 兼容网关**:新建独立 id 的模板(不要改 `openai.json` 的 base_url,它必须为 null)。
- **Responses↔Chat 自建适配器**:不在本仓库范围(独立子项目);`responses_support=gateway` 留给这类网关。
