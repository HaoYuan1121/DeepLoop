# 用 PI 的 Agent（Loop Engineering）替换 DeepSeek Harness 的 Agent：可行性分析与 deepseek-pi 落地

> 本文档回答两个问题：(1) 将 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent（`dsh-agent-loop`）替换为 PI 的 agent（即 [loop engineering](https://arxiv.org/pdf/2607.20709)，实践范本为 [Pi Coding Agent](https://github.com/earendil-works/pi)）是否合理；(2) deepseek-pi 文件夹中"如何替换、替换到什么程度"。
>
> 结论先行：**合理，且 DSH 的架构为此专门留了缝**（`dsh-agent` 明确声明 "zero loop dependency, so the loop is swappable"；仓库已存在 `dsh-llm-pi-ai`，证明 pi-ai 集成是官方认可的方向）。deepseek-pi 已经完成了第一阶段的源码级替换并通过了离线类型检查（`tsc -b` 全绿）。

---

## 1. 背景

- **deepseek-harness**（DSH，v0.1.0-rc.7）：基于 vendored Cordis 的插件式 agent harness，"一切都是插件"。agent 由两个包构成：
  - `packages/core/agent`（`dsh-agent`）：`Agent` 接口、注册表、initiator scope、`agent/*` 事件词汇表。**零循环依赖，循环可替换**。
  - `packages/core/agent-loop`（`dsh-agent-loop`）：具体驱动器 `ReactLoopAgent` + `AgentFactory`，是唯一包含具体循环逻辑的包。
- **pi**（PI / pi-mono）：badlogic（nolanaatemia）的终端 coding agent。其 agent 即 **loop engineering**：一个最小、可组合的 agent loop（`runAgentLoop` / `Agent` 类），配以事件流、steering/follow-up 队列、`beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn` 钩子、并行/串行工具执行。
- **目标**：新建 `deepseek-pi` 文件夹 = DSH 的骨架 + PI 的 agent 引擎，把 DSH 的 `ReactLoopAgent` 换成 PI 的 loop，同时保留 DSH 的会话日志、事件词汇表、工具流水线、插件生态。

## 2. 两套 agent 架构对照

| 维度 | DSH `ReactLoopAgent` | PI loop engineering |
|---|---|---|
| 循环形态 | 显式状态机（phase: idle/maintenance/running，turn/step 边界，inbox claim） | 隐式 while 循环：LLM 调用 → 工具执行 → steering/follow-up 轮询 |
| 待办输入 | 双队列 inbox：`next-turn` / `next-step`，带 `MessageId`、claim/splice 语义 | 两个队列：steering（turn 内注入）、follow-up（loop 将停时注入），`one-at-a-time`/`all` 模式 |
| 中断/续跑 | `cancel(cause)` + wake latch；`whenIdle()` 全量 quiescence | `abort()`（AbortSignal）+ `waitForIdle()` |
| 扩展点 | Cordis 插件事件：`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`、`tools/*` 流水线 | 构造期钩子：`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`、`prepareNextTurn`、`transformContext` |
| 持久化 | 会话事件日志（`SessionEventMap`）为唯一事实源，`request/header` 折叠、KV-cache 友好的增量化 | 进程内 transcript（`state.messages`）；持久化由宿主（PI 的 session backend）负责 |
| 工具 | `ToolRuntime` 流水线：pre-execute → guard → execute → post-execute → result，带排他/并行调度 | `AgentTool.execute(toolCallId, params, signal, onUpdate)`，typebox schema |
| LLM | `ctx.llm` 服务 + adapter（deepseek / **pi-ai** / middleware），`prepareCall` 解析默认值 | `StreamFn` + pi-ai `Model`；pi-ai 自带全量 provider |
| 模型可见性 | 任何进请求的内容必须能从会话日志重建（invariant 强制） | 无强制；由宿主保证 |

## 3. 接口映射（DSH `Agent` ⇄ PI loop）

DSH `Agent` 接口与 PI loop 的能力几乎一一对应，这是"替换"可行性的核心：

| DSH `Agent` | PI loop | 映射难度 |
|---|---|---|
| `inbox.next-turn` / `followup()` | `getFollowUpMessages` 轮询（follow-up 队列） | 低：适配器把 DSH inbox 的 claim 喂给 PI 轮询钩子 |
| `inbox.next-step` / `steer()` / `inject()` | `getSteeringMessages` 轮询（steering 队列） | 低：同上 |
| `cancel(cause, {keepInbox})` | `AbortSignal` abort | 低：phase.abort 与 PI 运行信号融合 |
| `whenIdle()` | `waitForIdle()` / 运行 promise | 低 |
| `agent/pre-step`、`agent/turn-stopping` 瀑布 | steering/follow-up 轮询点 + `shouldStopAfterTurn` | 中：适配器在轮询钩子里跑 `agent/pre-step` 瀑布，保持插件（compaction 等）可见 |
| `tools/*` 流水线 | `AgentTool.execute` | 中：桥接工具把执行委托回 `ToolRuntime.execute`，策略流水线保持权威 |
| `ctx.llm`（adapter 语义） | `StreamFn`（pi-ai 事件流） | 中：`pi-stream.ts` 把 harness `StreamChunk` 反向翻译成 pi-ai `AssistantMessageEvent`（正向翻译已存在于 `dsh-llm-pi-ai` 的 `toStreamChunks`，本桥是其镜像） |
| 会话日志（durable surface） | 进程内 transcript | 中高：适配器把 PI 事件投影为会话事件（`turn/start` → `step/start` → `user/message`/`assistant/message`/`tool/call`+`tool/result` → `step/end` → `turn/end`），resume 时从 surface 重建 PI transcript |
| `request/header` / `request/context` / KV-cache 折叠 | 无对应物 | 中：`pi-stream.ts` 完整复刻 DSH `buildRequest` 的记账逻辑，保住 invariant 与 KV-cache 性质 |
| `agent/request-error` 重试恢复 | 无（loop 内自动结束 turn） | 高：PI loop 对错误 turn 直接 `agent_end`，DSH 的 retry 插件（`dsh-llm-retry`）需要适配层才能在 PI 语义下生效 |

## 4. 合理性分析

### 4.1 为什么合理

1. **DSH 架构显式支持循环替换**。`dsh-agent` 的 README 原文："Replace the loop by implementing `Agent` and registering via `ctx.agents.register()`."——`Agent` 接口就是设计好的替换缝，`agent-loop` 之外的 40+ 插件包全部编程于接口而非具体循环。
2. **pi-ai 集成已有官方先例**。仓库自带 `packages/llm/llm-pi-ai`（"design-verification twin of dsh-llm-deepseek"），说明 DSH 团队已经认可 pi-ai 的模型抽象可接入 harness LLM 接缝。本次替换把集成从 LLM 层推进到循环层，方向一致。
3. **能力几乎逐条对应**（见 §3）。steering/follow-up、abort/whenIdle、工具执行、事件流——两侧语义高度同构，适配是"接线"而非"重写语义"。
4. **loop engineering 与插件化不冲突**。PI 的"最小循环 + 钩子"哲学与 DSH 的"插件围绕小核心"哲学同向；把 PI 循环作为核心、DSH 插件作为外围，正是两者理念的交集。
5. **真实收益**：获得 PI 循环的简洁性、`beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn` 这类面向模型行为的钩子、以及紧跟 PI 上游的 loop 演进；同时保留 DSH 的会话持久化、事件词汇表、工具/沙箱/子代理插件生态。

### 4.2 风险与代价（为什么不是免费的）

1. **持久化双轨**。PI loop 以进程内 transcript 为源，DSH 以会话日志为源。适配器必须维持二者的同步（每次 PI 事件投影到日志、resume 时从日志重建 transcript）。任何漏投影都会导致 `deriveMessages()` 与请求不一致，触发 `dsh-agent-loop/invariant` 的 request-reconstruction 检查。
2. **语义差异被抹平后有损失**：
   - turn 粒度：PI 每次助手响应 = 一个 DSH turn（含一步），上游一个工具循环在同一 turn 内完成。日志形态不同，新旧循环的会话不可互换。
   - 并行工具调度：PI 串行执行（保留 harness 顺序保证），上游的 bounded parallel pool（`maxParallelToolCalls`）未实现。
   - 错误恢复：PI 对错误 turn 直接终止，DSH 的 `agent/request-error` retry 语义需要适配。
3. **依赖闭包**：PI 的 `pi-ai` 全量带 provider SDK（anthropic/openai/aws/google）。deepseek-pi 选择**不 vendor provider 层**，改为让 harness LLM 接缝供模型调用（`dsh-llm-pi-ai` 正是此接缝的现成消费者），因此只 vendor 了 pi-ai 的类型/事件子集——这保持了零外部运行时依赖，但意味着 `pi-ai` 自带的 provider 目录不可直接用。
4. **测试负债**：上游 `ReactLoopAgent` 测试套件不适用于 PI 循环，需重写。
5. **上游漂移**：vendored pi 代码需要按 DSH 的 vendor 流程（`vendor/README.md` 的同步程序）定期跟进。

### 4.3 结论

**可行**。这是"换引擎、留骨架"的架构级替换，而非重写。DSH 为此预留的接缝、已有的 `dsh-llm-pi-ai` 先例、以及两侧接口的近似同构，使替换的工程量收敛到"一个适配器包"（`dsh-agent-loop` 内部约 1500 行新代码 + 两个精简 vendored 包）。代价集中在持久化同步、turn 粒度、并行调度与错误恢复四处，均已列入 Known Limitations 或后续计划。

## 5. deepseek-pi 的落地结构（已实现）

```
deepseek-pi/
├─ packages/core/agent-loop/          # 被替换的循环（包名与插件契约不变）
│  ├─ src/index.ts                    # AgentLoop 服务/AgentFactory（仅驱动类型改为 PiLoopAgent）
│  ├─ src/pi-agent.ts                 # PiLoopAgent：DSH Agent 接口 + 驱动 PI runAgentLoop
│  ├─ src/pi-model.ts                 # pi-ai Model shim + pi↔harness 消息转换
│  ├─ src/pi-stream.ts                # StreamFn 桥：harness LLM 接缝 → pi-ai 事件流
│  ├─ src/pi-tools.ts                 # ToolSchema → PI AgentTool（执行委托回 ToolRuntime）
│  ├─ src/invariant.ts                # 保留：request-reconstruction 检查
│  └─ src/{agent,tool-calls,runtime-context}.ts   # 已删除（被替换的上游驱动器）
├─ vendor/pi-ai/                      # vendored @deepseek-pi/pi-ai（类型+EventStream+校验精简版）
├─ vendor/pi-agent-core/              # vendored @deepseek-pi/pi-agent-core（Agent/runAgentLoop 核心）
├─ tsconfig.base.json                 # 新增 @deepseek-pi/* paths
└─ vendor/README.md                   # pi 包 manifest + local modifications 日志
```

数据流（一次 prompt）：

```
followup() ──> DSH inbox(next-turn) ──claim──> runAgentLoop(prompts, ctx, config, emit, signal, streamFn)
                                                      │  getSteering/FollowUpMessages 钩子 ──claim inbox──> agent/pre-step 瀑布（插件可见）
                                                      │  streamFn ──> ctx.llm.prepareCall + adapter stream ──> request/header 记账 + markAgentLoopRequest
                                                      │  emit ──> 会话事件投影（turn/step/user/assistant/tool/call+result）
                                                      └─ 工具：AgentTool.execute ──> ToolRuntime.execute（策略流水线权威）
```

## 6. 验证情况

### 6.1 离线阶段（沙箱无网络）

- 环境限制：沙箱无网络（TLS 被阻断），`pnpm install` 不可行，因此**未**执行完整 `pnpm run build/test`。
- 已完成：使用 npx 缓存中的 `typescript@7.0.2` 对 `dsh-agent-loop` 的**完整 project-reference 图**（vendor/cordis、vendor/pi-ai、vendor/pi-agent-core、dsh-agent、dsh-llm、dsh-session、dsh-tools、dsh-scope、dsh-system-prompt、dsh-settings、session-persistence、invariants）执行 `tsc -b`，**exit 0**。vendored pi 两个包单独 `tsc` 亦全绿。

### 6.2 有网络环境的实测结果（2026-08，用户机器）

用户执行 `pnpm install && pnpm run build:lib:host && pnpm run test:gui` 后，实测状态：

- **`pnpm run build:lib:host`：通过**（tsc -b + tsdown 全量构建，包含被替换的 `dsh-agent-loop`）。
- **`pnpm run test:gui`：通过**（272 个文件 / 3783 个测试全绿）——client/host 全部 GUI 面不受影响。
- **agent-loop 自身测试：重写后全绿**（60 个测试）。上游 `ReactLoopAgent` 的 12 个旧驱动器 spec 已删除（loop、tool-calls、tool-order、cancel、interception、request-error、request-reconstruction、coverage-edges、agent-initiator、resume、agent、config-session-id），替换为新的 `tests/pi-loop.spec.ts`（turn 投影、工具往返、max-tokens、steer/followup、cancel、inject）。
- **端到端冒烟：通过**。`pnpm mock:llm --sequence success --repeat-last` + `DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1` + `pnpm dsh --profile headless "任务"` → exit 0，结果从会话日志正确推导。此过程中发现并修复三个真实 bug：
  1. `pi-stream` 对 `prepareCall` 的二次调用违反 `PreparedLlmCall` 单次分发约束 → 复用首次 prepared call；
  2. 请求消息必须使用 `session.deriveMessages()`（日志对象，含身份），否则 `dsh-agent-loop/invariant` 的 log-reconstruction 检查报错 → 已改；
  3. 流迭代中逐 chunk `throwIfAborted()` 会吞掉终止性的 `aborted` finish chunk → 已移除（abort 由 harness 流归一化为 terminal finish）。
- **全量 `pnpm run test`：12434 通过 / 204 失败 / 65 跳过**。失败分两类：
  - **交换相关（约 100+）**：下游包（acp 28、subagent ~33、goal-round-driver 33、llm-retry 35、compaction-basic 6、plan-mode 2、time-context 3、agent-spine-demo 4、repeat-tool-reminder 12）的测试断言的是**旧循环的精确语义**（每次助手响应对应一个 turn 的 turn/step 计数、`agent/request-error` 重试恢复、调度器工具顺序、pre-step 时序）。这是"换引擎"的固有测试债（README Known Limitations 已列），修复方向是改下游测试期望或补齐适配（见 §7 P3）。
  - **环境相关（约 50+）**：Windows 沙箱符号链接 EPERM、权限、超时等（workspace、fs、sqlite、scripts/* 等），与交换无关。
- **Web GUI**：`dsh --profile web --dump-config` 确认挂载 `dsh-agent-loop`（PI 驱动）+ `dsh-llm-deepseek` + `dsh-llm-pi-ai`。前端需依次 `pnpm run build:lib:client`（产出 client 面 `lib/styles`）与 `pnpm run build:web` 后，`pnpm dsh web` 启动。

## 7. 后续工作（分阶段）

- **P1（已交付）**：源码级替换 + vendored pi 核心 + 类型检查通过。
- **P2（已完成）**：`pnpm install && pnpm run build:lib:host && pnpm run test:gui` 通过；agent-loop 测试重写为 PI 循环语义并全绿；端到端 headless 冒烟通过。
- **P3（进行中）**：补齐适配差距——`agent/request-error` retry 恢复（修复 llm-retry / acp turns 大部分失败）、pre-step 时序与 turn/step 语义对齐（compaction / time-context / plan）、`maxParallelToolCalls` 并行调度、`assistant/chunk` 增量投影、`RuntimeContextProjection` 等价物、图像内容桥接；随后重写下游包（acp/subagent/goal）测试期望。
- **P4**：端到端 snapshot 测试（`test:snapshot`）+ 一个真实可运行的示例（沿用 DSH 的 keyless snapshot 政策）。
- **P5**：文档同步（docs/architecture.md 的 turn-flow 描述、中文 README 全文）、`pnpm run doc-sync`、`pnpm run hygiene`。

## 8. 复现命令（需网络）

```sh
cd deepseek-pi
pnpm install
pnpm run build:lib:host      # tsc -b tsconfig.host.json + tsdown
pnpm run test:gui            # packages/client + packages/host 单元测试
pnpm run test:snapshot       # keyless 回放
pnpm dsh --profile headless "task"   # 需要 DEEPSEEK_API_KEY 的真实调用
```

## 9. 参考

- DSH：`packages/core/agent/README.md`（swappable loop）、`packages/core/agent-loop/README.md`（本仓库版本：PI 驱动）、`packages/llm/llm-pi-ai/README.md`（pi-ai 接缝先例）、`vendor/README.md`（pi vendoring manifest）。
- PI：`pi/packages/agent/README.md`（`@earendil-works/pi-agent-core`）、`pi/packages/ai/README.md`（pi-ai）、[Loop Engineering 实践: Pi Coding Agent](https://zhu327.github.io/2026/06/17/loop-engineering-%E5%AE%9E%E8%B7%B5-pi-coding-agent/)、[Loop engineering (arXiv 2607.20709)](https://arxiv.org/pdf/2607.20709)。
