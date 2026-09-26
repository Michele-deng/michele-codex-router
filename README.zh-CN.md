# Michele-Codex 模型路由器（Jev router / OpenAI Codex 的模型故障切换代理）

[English README](README.md) · [给 AI 助手的安装说明](INSTALL.md)

本地优先的 Windows Codex 模型路由器。它决定**每一轮由哪个模型来干活**，
然后代理请求——Codex 的工具、权限、登录、会话和原生 `/model` 界面全部保留。

```text
用户 -> jev-codex 启动器 / 桌面版
             |
             v
      本地代理(127.0.0.1) ---> Jev 决策(硬超时, fail-open)
             |
             v
          Codex -> OpenAI / DeepSeek / 任意可配置上游
```

> 内部代号说明：npm 包与代码标识符仍是 `jev-router` / `@jev-router/*`，
> 对外项目名为 **Michele-Codex 模型路由器**。

## 它做什么

- **模型选择就是开关**：模型列表选 **Jev Auto** = 每轮自动路由；选具体模型
  = 当轮暂停路由（原生 `/model` 即开关）。
- **一个回合一个模型**：工具循环中途绝不换模型；一旦开始输出绝不静默切换。
- **技术故障自动切换**：401/402/403/404/429/529、`model_not_found`、
  额度、超时、网络、配置错误 → 用**完整原始请求**立刻重试下一候选（最多 3 次尝试）。
- **带记忆的模型健康**：普通故障 30 秒起指数冷却到 10 分钟；账号级拒答直接
  冷却 10 分钟，累计 **3 次且期间无成功 → 永久停用**，直到手动成功或
  `health-reset`。状态持久化在 `~/.jev-router/model-health.json`。
- **质量失败不自动换**：写得烂、测试不过请用原生 `/model` 手动换——
  自动化只处理技术故障。
- **有界、隐私友好的决策**：Jev 最多收到 8000 字符任务摘要 + 4000 字符
  上下文摘要，绝不发送代码、工具输出、授权头或密钥；决策硬超时（默认
  800ms，中转慢建议 4000ms）超时立即 fail-open。

## 环境要求

- Windows 10/11（唯一实测平台，启动文件夹与 PowerShell 逻辑为 Windows 专用）
- Node.js 20.12+
- Codex CLI / 桌面版，已登录
- 可选：Jev/TypeSafe API Key（没有也能用，回退规则路由）
- 可选：opencodex 或任意 OpenAI 兼容上游（模型访问通道）

## 快速开始

```powershell
cd <PROJECT_PATH>
npm install
npm run setup:key        # 打印 .env 位置；填 TYPESAFE_API_KEY
npm run health           # 期望 "ok": true，绝不打印密钥内容
```

**桌面接入（日常推荐）：**

```powershell
node apps\jev-cli\dist\index.js desktop enable    # 期望 "issues": []
node apps\jev-cli\dist\index.js desktop status    # 期望 "ok": true
```

然后打开 Codex，在模型列表选 **Jev Auto** 即开始路由；`desktop disable` 卸载。

**让 AI 帮你装**：把 [INSTALL.md](INSTALL.md) 整段丢给你的 AI 编程助手——
每一步都有机器可检验的期望输出，还带"报错原文 → 解法"对照表。

## 本次安装会改你电脑上的哪些文件

| 路径 | 改动 | 如何还原 |
| --- | --- | --- |
| `C:\Users\<你>\.codex\config.toml` | 新增 `model_provider`、带 `# Jev-Router managed` 标记的 `[model_providers.jev_router]` 块、`model_catalog_json` | 自动：改前先备份到 `~\.jev-router\config.toml.backup`；`desktop disable` **只按键值字节级还原这几处** |
| 启动文件夹 \ `jev-router-proxy.vbs` | 新增隐藏自启项 | `desktop disable` 删除 |
| `~\.jev-router\` | 新建数据目录（日志、合并目录、健康记录、备份） | 想彻底清理直接删该文件夹 |

**绝不修改**：`~/.codex/auth.json`、Codex 登录状态、opencodex 自己的目录文件、
opencodex 注入的 `openai_base_url`、你的默认模型。

建议首次 enable 前手动再存一份（最后的保险）：

```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:USERPROFILE\Desktop\config.toml.manual-backup"
```

还原验证方法（第一次与第三次哈希必须相同）：

```powershell
$c = "$env:USERPROFILE\.codex\config.toml"
(Get-FileHash $c).Hash        # 状态 B：已接入
node apps\jev-cli\dist\index.js desktop disable | Out-Null
(Get-FileHash $c).Hash        # 状态 A：我们没碰过的样子
node apps\jev-cli\dist\index.js desktop enable | Out-Null
(Get-FileHash $c).Hash        # 必须等于第一次的哈希
```

2026-09-27 实测结论：反复 enable/disable 产生的状态对字节级一致。注意
Codex 自己也会随时间改 `config.toml`（测试机上它自己加过一个 `[tui]` 块），
所以几天前的整文件副本哈希不同属正常——路由器故意只还原自己的键、不回滚
整个文件，Codex 自己的设置因此永远幸存。

## 命令

下表 `jev` 即 `node apps\jev-cli\dist\index.js <命令>`（`jev-codex`
有独立 .cmd 包装）。

| 命令 | 作用 |
| --- | --- |
| `jev-codex [args]` | 通过代理启动 Codex |
| `jev route [--model ID] 任务` | 打印一次路由决策 |
| `jev profiles` | 列出模型档案 |
| `jev health` | 配置与模型健康（无密钥） |
| `jev health-reset [modelId]` | 清除永久停用的健康记录 |
| `jev explain` | 最近一次决策及尝试链 |
| `jev desktop enable / status / disable` | 桌面接入管理 |
| `jev mcp` | 可选 MCP 决策服务（非核心） |

## 路由规则（优先级从高到低）

1. 用户显式指定的模型（`-m/--model` 或原生 `/model`）——不自动切换。
2. 硬约束：上下文上限、工具能力、成本；frontier 档位需 `JEV_ALLOW_LONG=1`。
3. 任务与模型能力匹配（Jev 决策、硬超时、fail-open）。
4. 成本、缓存亲和、实时健康状态。
5. Jev 置信度——低置信度不允许降档。

## 配置

完整模板见 `.env.example`。真实环境变量 > `.env` > 默认值。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 空 | Jev 决策 Key（可选） |
| `JEV_DECISION_PROVIDER` | `typesafe` | `typesafe` / `static` |
| `JEV_ROUTE_TIMEOUT_MS` | `800` | 决策硬超时；慢中转建议 4000 |
| `JEV_FALLBACK_PROVIDER` / `_MODEL` | `deepseek` / 空 | 故障兜底 |
| `JEV_CODEX_UPSTREAM_URL` | OpenAI responses | OpenAI 兼容上游 |
| `DEEPSEEK_BASE_URL` / `_KEY` | 空 | 独立 DeepSeek 端点/Key |
| `JEV_PROXY_PORT` | `10300` | 桌面固定代理端口 |
| `JEV_UPSTREAM_TIMEOUT_MS` | `60000` | 上游头响应期限（小于 Codex 约 113 秒的耐心） |
| `JEV_ALLOW_LONG` | `0` | 允许 frontier 档参与 |

## 隐私与安全

- 决策方只收到有界摘要（8k/4k 字符），没有源码、工具输出、授权头、密钥。
- 代理只监听 `127.0.0.1`；日志存任务哈希、模型、档位、置信度、延迟、
  token、尝试链，全部经过密钥脱敏测试。
- 自动路由只选模型，绝不放宽 Codex 权限或审批。

## 已知限制

- **仅 Windows**（Windows 10/11 + Codex CLI 0.158.0-alpha.2 实测）。
- 非官方项目，与 TypeSafe（Jev）、OpenAI、opencodex 无隶属关系；"Jev" 是
  TypeSafe 的产品名，此处仅用于指代它提供的决策 API。
- opencodex 是第三方、版本敏感依赖；账号/渠道决定哪些模型可用（测试机上
  luna/terra/深搜可用、sol/astra 被拒——健康系统正是为此存在）。
- 本地决策 provider（Ollama/LM Studio/Laya）未实现，`local` 模式回退规则。
- 交互式 `/model` 菜单点选是唯一待人工确认的步骤（目录条目与
  `-m jev/auto` 已验证）。

## Demo 录制步骤（发帖用）

1. `desktop enable` → `desktop status` 全绿（5 秒）。
2. 打开 Codex 桌面版 → `/model` → 选 **Jev Auto**。
3. 问个小问题 → 跑 `jev explain` → 展示模型/档位/置信度/尝试链（5 秒）。
4. 切到某个具体模型 → 下一问日志无新增（路由已暂停）。
5. ScreenToGif/OBS 录制，控制在 10 秒内，遮掉任何密钥和个人路径。

## 测试与验证状态

- `npm test`：**61 个单元/集成测试**（配置优先级、密钥脱敏、错误分类、
  冷却/三振出局、决策超时、SSE 不缓冲、故障切换、租期粘性、手动旁路、
  回环端口、配置注入/还原往返）。
- CI（GitHub Actions）：Node 20/24 矩阵 + 密钥/个人路径扫描。
- 真实验证：`codex exec --ephemeral` 单轮与工具循环、桌面
  enable → 透传 → `-m jev/auto` 决策 → disable 哈希还原 → 重新 enable。

## 评测

30 个代表性任务与四策略对比方法：
[`evals/tasks.json`](evals/tasks.json)、[`evals/README.md`](evals/README.md)。

## 许可证

[MIT](LICENSE) © 2026 dengxingyue
