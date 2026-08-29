<p align="center"><b>简体中文</b> | <a href="README_en.md">English</a></p>

<h1 align="center">Vibe Research</h1>

<p align="center">
  <b>基于 Codex Harness 打造的本地金融研究工作台</b><br>
  已接通 Codex 与 Claude Code 订阅 · 自动检测本机登录状态 · 支持大多数兼容模型 API
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-v1.0.0-F35D2B">
  <img alt="UI" src="https://img.shields.io/badge/UI-React%20%2B%20Vite-646cff">
  <img alt="Orchestrator tests" src="https://img.shields.io/badge/orchestrator-525%20tests-passing">
  <img alt="Desktop tests" src="https://img.shields.io/badge/desktop-22%20tests-passing">
  <img alt="Codex Harness" src="https://img.shields.io/badge/runtime-Codex%20Harness-black">
</p>

<p align="center">
  <a href="https://viberesearch.wiki">官方网站</a> ·
  <a href="#这是什么">这是什么</a> ·
  <a href="#功能">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#模型接入">模型接入</a> ·
  <a href="#数据与市场">数据</a> ·
  <a href="#安全与隐私">安全</a> ·
  <a href="#开发与测试">开发</a> ·
  <a href="#当前边界">边界</a> ·
  <a href="CHANGELOG.md">CHANGELOG</a>
</p>

---

## 这是什么

Vibe Research 是一个**基于 [OpenAI Codex Harness](https://developers.openai.com/blog/codex-as-a-platform)
打造的本地金融研究工作台**。Codex Harness 在本机维持上下文、选择工具、推进任务、处理失败并保留
过程；Vibe Research 再叠加金融数据源、研究 SOP、确定性计算、证据校验和合规边界。

上一版 Vibe Research 主要由应用直接调用模型 API 完成分析。现在它被改造升级为一个基于 Codex 的
本地金融 Agent：能够理解任务、连续调用工具、补充缺失信息、执行多步研究并保存完整过程。相比单次
API 问答，长任务能力、工具使用、上下文保持和推理质量都会显著提升。

| 上一版：直接调用模型 API | 当前版：Codex 本地金融 Agent |
|---|---|
| 一次请求完成一次分析 | 持续推进完整研究任务 |
| 应用预先决定调用什么 | Agent 读取真实工具目录后自主选择 |
| 上下文和任务状态由页面临时维护 | Harness 在本机维护上下文、进度和失败恢复 |
| 结果通常只有一段回答 | 保留报告、证据、计算过程、缺口和运行状态 |
| 模型输出直接展示 | validator、沙箱、hooks 与合规 gate 共同把关 |

架构同时支持订阅型 AI 与模型 API 两类接入。当前已接通 Codex 与 Claude Code 两个订阅入口；设置页会
实时检测本机 CLI、版本与登录状态。Codex 未登录时可直接点击“登录 Codex”打开官方授权页，授权完成后
自动识别；Qwen Code 与 DeepSeek CLI 当前仍需
各自的 API key，因此归入 API 接入，不冒充免 key 订阅。API 侧支持大多数提供 Responses API 的模型服务。

## 功能

| 模块 | 当前能力 |
|---|---|
| 首页 Agent | 打开首页即可对话；可直接提出公司、行业、复盘或研究任务 |
| 每日复盘 | 汇总市场、热点、涨停原因和当日线索 |
| 资讯雷达 | Investment News 标题翻译、公开新闻、A 股公告和事件概率 |
| 产业信号 | GPU 租金、月频产业数据、原材料、招聘和数据日历 |
| 板块中心 | 查看板块表现并下钻到具体产业方向 |
| 个股研究 | A 股六阶段研究：公司画像、财务、一致预期、估值、风险、报告 |
| 我的研报 | 本地保存 PDF、DOCX、TXT、MD、CSV；抽取、检索、引用、下载和删除 |
| 回测 | 只提供 Agent 对话入口；信息不足时补问，齐备后调用真实回测工具 |
| 多空辩论 | 多方、空方、反驳与中立主持共用同一份真实资料包 |
| 自选股与持仓 | 支持 A 股、美股和港股代码识别、本地保存与行情刷新 |
| 研究记录 | 保存研究、回测和辩论报告，可搜索、按时间查看和删除 |
| 接入 AI | 选择订阅登录或填写自己的模型 API；全站 Agent 共用这一份配置 |

### 研究结果不是一段无法复核的文字

六阶段研究会产出：

- `report.md`：最终研究报告。
- `evidence.json`：本轮使用的证据，每条保留来源、资料期和原文引用。
- `calculations.json`：派生数字的输入、函数和计算 DAG。
- `conflicts.json`：跨来源冲突，不静默取舍。
- `manifest.json`：模型、版本、阶段、状态、资料召回和运行清单。
- `viewer.html`：可在浏览器查看证据与报告。

任何关键数据拿不到，状态都会变成 `incomplete` 或 `failed`，不会用旧值或猜测填空。

## 快速开始

### 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS 或 Linux；当前主要验证环境为 Apple Silicon macOS |
| Node.js | ≥ 22.18，推荐 24 LTS |
| Python | ≥ 3.10，当前验证版本为 3.12 |
| Codex CLI | 已验证 0.149.0；版本锚点见 `codex-version.json` |
| 模型 | ChatGPT / Claude.ai 订阅登录，或支持 Responses API 的模型服务 |

### 安装依赖

```bash
git clone https://github.com/simonlin1212/Vibe-Research.git vibe-research-agent
cd vibe-research-agent

npm install --prefix orchestrator
npm install --prefix desktop

python3 -m venv .venv
.venv/bin/pip install -r .agents/skills/data-access/scripts/requirements.txt

npm install -g @openai/codex@0.149.0
scripts/init --python "$(pwd)/.venv/bin/python"
```

### 连接模型

使用 ChatGPT 订阅：启动界面后进入“接入 AI”→“订阅接入”，点击“登录 Codex”，在自动打开的
OpenAI 官方页面完成授权；页面自动识别登录结果后，点击“测试并保存”。产品使用独立的
`.local/codex-home`，不会读取或覆盖用户的 `~/.codex`。浏览器未自动打开时，可用
`CODEX_HOME="$(pwd)/.local/codex-home" codex login` 作为后备方式。

使用 Claude.ai 订阅：先安装并登录 Claude Code；设置页会自动检测，不需要把 Claude 的 key 填进产品。

API 接入：进入“接入 AI”→“API 接入”，选择供应商并填写 API 地址、模型名和 key，再点击
“测试并保存”。系统先发起一次真实模型对话，成功才保存并供所有 Agent 页面使用。出现“请先到接入 AI
重新连接”时，表示本机登录态已失效，不是研究或回测逻辑失败。

### 启动浏览器 UI

打开两个终端：

```bash
# 终端 1：本地 API
node orchestrator/src/api.ts --port 8765
```

```bash
# 终端 2：React 界面
npm run dev --prefix desktop
```

浏览器打开 [http://127.0.0.1:5930](http://127.0.0.1:5930)。

Vite 只在本机代理 `/api/*`，并在服务端补上鉴权信息。若设置了 `VRA_DATA_ROOT`，两个进程必须使用
同一个值。

### 命令行运行一次研究

```bash
node orchestrator/src/run.ts \
  --symbol 300308 \
  --market SZ \
  --python "$(pwd)/.venv/bin/python" < /dev/null
```

完整研究通常需要 15–19 分钟。进度会持续显示，结果写入 `.local/runs/<run-id>/`。
退出码：`0` complete、`2` incomplete/stale、`3` failed。

## 工作方式

```text
浏览器工作台
首页 Agent · 复盘 · 资讯 · 个股研究 · 回测 · 资料库
        │
        ▼
金融 Agent 层
117 个数据端点 · 六阶段 SOP · calc · validator · report archive
        │
        ▼
OpenAI Codex Harness
agent loop · context · tools · progress · sandbox
        │
        ▼
Local Agent Runtime
Codex SDK · Claude Code CLI（本机检测 / 登录探针 / 受限执行）
        │
        ▼
Model Provider
ChatGPT / Claude.ai 订阅 · OpenAI · DeepSeek · Qwen · GLM · Kimi · MiMo · compatible API
```

三级约束不会只依赖提示词：

| 层 | 组成 | 作用 |
|---|---|---|
| 提示层 | `AGENTS.md` + `.agents/skills/` | 定义金融研究纪律与 SOP |
| 执行层 | Codex hooks + workspace sandbox | 限制联网、文件访问、取数和产物范围 |
| 编排层 | orchestrator + validator + calc + gate | 强制阶段、证据引用、确定性计算和合规边界 |

项目不修改 Codex 源码。Codex 仓库只作上游参考，产品通过官方 CLI 与 SDK 使用 Harness。

## 模型接入

“接入 AI”把 Agent Runtime 与 Model Provider 分开：

- Codex Harness 负责本地上下文、工具调用、任务状态、进度和失败处理。
- Local Agent Runtime 把订阅登录接进工作台；当前支持产品内 Codex 与本机 Claude Code，并实时检测版本和登录状态。Codex 可从设置页启动官方登录，授权完成后自动检测。
- Model Provider 只提供推理能力；换模型不会换掉工具、记忆、证据链或金融纪律。
- Codex 订阅使用产品自己的 `CODEX_HOME`，不读写用户的 `~/.codex`；Claude 订阅复用本机 Claude Code 登录态，调用时强制关闭本地工具、MCP、联网搜索工具与会话落盘。
- 无论订阅或 API，点击“测试并保存”都会先做一次真实对话探针；探针失败不覆盖当前已生效配置。
- API 模式的 key 只保存在当前浏览器 `localStorage`，随请求交给本机后端，不写入仓库、配置文件、
  运行账本或日志。

内置 provider 模板：OpenAI、DeepSeek、Qwen、GLM、Kimi、MiMo，以及 `selfhosted` 自托管占位模板
（vLLM / SGLang / LM Studio / Ollama 等 OpenAI 兼容端点，私有化部署走 §自托管模型）。引擎只支持 Responses API；
模板存在不等于已经通过兼容矩阵，界面会区分“已实测”和“有模板、未实测”。

详细说明见 [docs/model-access.md](docs/model-access.md) 和 [providers/README.md](providers/README.md)。

## 数据与市场

- 当前注册表：**117 个端点、30 层**，覆盖 CN、US、HK。
- 数据类别：行情、K 线、财务、一致预期、公告、研报、资金、筹码、期权、SEC/FINRA/CBOE、
  新闻、宏观、产业温度计、招聘、管制与数据日历。
- A 股、美股和港股都可用于自选股、持仓、资料归档与 Agent 对话。
- **六阶段个股研究目前只支持 A 股。** 港美市场不会启动一条没有完整数据链的空研究。
- 扫描版 PDF 需要先 OCR；文本型 PDF 会保留页码引用。

端点目录见 [datasources/CATALOG.md](datasources/CATALOG.md)。

## 项目结构

| 路径 | 作用 |
|---|---|
| `desktop/` | React + Vite 本地浏览器 UI |
| `orchestrator/` | Agent 编排、validator、API、MCP、对话、资料库与报告归档 |
| `backtest/` | 确定性回测引擎与工具入口 |
| `calc/` | 确定性计算库 |
| `datasources/` | 数据端点注册表、目录和健康巡检 |
| `.agents/skills/` | 金融研究 SOP 与取数工具 |
| `providers/` | 模型 provider 模板，不包含密钥 |
| `scripts/` | 初始化与体检 |
| `.local/` | 用户私有数据、报告、登录态和运行产物；已 gitignore |

## 安全与隐私

- 原始研报文件只保存在本机；模型只接收服务端检索命中的正文片段。
- 后端默认 provider 的 key 只走环境变量，不写入产品配置或仓库。
- 浏览器里填写的 API key 只保存在当前浏览器 `localStorage`，仅在调用时经本机后端转给所选模型服务商。
- 资料对话关闭 Shell、图片读取、子代理、插件、应用和联网能力。
- 资料引用格式为 `[资料:<id> p.<页码>]`，漏引、错引和未知引用会被机器校验拒绝。
- Agent 研究阶段无网络；取数由编排器使用受控脚本完成，原始响应落盘并记录哈希。
- 本机 API 默认只绑定 `127.0.0.1`，写请求必须鉴权并使用 JSON。
- 输出只包含数据、分析框架、情景概率和裁决点，不提供建仓、加减仓、目标价或止损位。

## 开发与测试

```bash
npm run typecheck --prefix orchestrator
npm test --prefix orchestrator

npm run typecheck --prefix desktop
npm test --prefix desktop
npm run build --prefix desktop

.venv/bin/python -m pytest calc/tests -q
.venv/bin/python -m pytest backtest/tests -q
.venv/bin/python -m pytest .agents/skills/data-access/scripts/tests -q
```

当前验证基线：

- orchestrator：**525/525**，Core 行业词 **0**，TypeScript 类型检查通过。
- desktop：**22/22**，TypeScript 类型检查与 Vite 生产构建通过。
- Python（计算库、回测、数据脚本）：**569/569**。
- V1.0.0 发布改动经 Codex 独立复审，末轮无可操作 P1/P2。

项目约定：每个环节完成后先测试，再做 Codex 独立审计、逐条核实、修复和复审；审计完成前不把
该环节称为“建成”，也不提交或推送。

## 当前边界

- V1.0.0 的交付形态是开源源码 + 本地浏览器 UI，需要分别启动本地 API 与浏览器界面。
- MiMo API 已完成从空配置到真实业务报告的端到端验证；其他第三方模型仍需使用者自己的 key，
  没有真实跑过兼容矩阵的模板不会标成“已实测”。
- Windows 尚未完成同等级验证。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 免责声明

本项目只产出研究数据、分析框架、情景概率与裁决点，不提供任何投资动作建议。所有输出均不构成
投资建议；第三方公开数据可能延迟、缺失或有误，使用者应自行核实并承担决策责任，同时遵守各数据源
的使用条款。

## 赞赏

<p align="center">
  <a href="https://buymeacoffee.com/simonlin1212"><img src="./assets/bmc-qr.png" width="180" alt="Buy Me a Coffee"></a>
</p>

## License

本仓库采用 [MIT License](LICENSE)。OpenAI Codex 使用 Apache-2.0；本仓库不包含 Codex 源码。

**作者：** Simon 林 · X [@linsizhen](https://x.com/linsizhen) · 邮箱：[simonlin0423@gmail.com](mailto:simonlin0423@gmail.com)
