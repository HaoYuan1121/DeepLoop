# DeepLoop

[English](README.md) | 中文

**DeepLoop = DeepSeek Harness 骨架 + PI 的 agent loop（loop engineering，循环工程）。**

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的衍生版本：把 harness 自带的 agent 驱动器（`packages/core/agent-loop` 中的 `ReactLoopAgent`）替换为 [Pi Coding Agent](https://github.com/earendil-works/pi) 的 agent 引擎——即 "loop engineering" 实践——并以 `@deepseek-pi/pi-agent-core`（+ `@deepseek-pi/pi-ai`）形式 vendored 到 `vendor/` 下。

deepseek-pi 除 agent loop 外原样继承 DeepSeek Harness 基础。参见：

- [docs/pi-agent-swap-analysis.md](docs/pi-agent-swap-analysis.md) —— 可行性分析（替换为何合理、接口映射、风险）。
- [packages/core/agent-loop/README.md](packages/core/agent-loop/README.md) —— 被替换的循环：`PiLoopAgent` 适配器、`pi-model` / `pi-stream` / `pi-tools` 桥接、已知限制。
- [vendor/README.md](vendor/README.md) —— vendored PI 包清单与本地修改日志。

状态：源码级替换已完成并端到端验证（构建、`test:gui`、重写后的 agent-loop 测试套件、基于 mock LLM 的 headless 冒烟、Web GUI）。全量测试：12434 通过 / 204 失败——失败为下游包断言旧循环精确语义（ACP/subagent/goal/retry/compaction/plan）加 Windows 环境问题；详见分析文档 §6.2 与 agent-loop README 的 Known Limitations。

## 为什么这样改（动机）

本次替换结合了两家的长处：

- **PI 的 agent loop 完成度高、效率好。** 实践中 pi-agent 的 loop engineering 能以较高效率基本成功完成大部分任务，每次 turn 的额外开销很小。
- **DeepSeek Harness 的 KV-cache 命中率极高。** 其会话日志折叠请求头、增量追加事件，使每次请求的大部分内容都能复用已缓存的上下文。

用 PI 的 loop 驱动 harness 缓存友好的会话层，有望显著节省 token：loop 发出的请求更少、更精简，harness 则最大化缓存复用。这一节省目前仍是假设、未经实测，实际体验有待真实用户验证。

## 启动（Run）

deepseek-pi 是源码检出、**未发布到 npm**，因此"从 npm 运行"不适用，只能从源码运行。

### 前置

安装 `Node.js`（≥ 22.19）与 `pnpm`（≥ 11），然后：

```sh
git clone <你的 deepseek-pi 仓库地址> deepseek-pi
cd deepseek-pi
pnpm install
pnpm run build          # tsc 产出 lib/types，tsdown 打包运行时，vite 构建 web 前端
```

### Web UI

```sh
pnpm dsh web
```

该命令启动 Web UI，默认地址 `http://127.0.0.1:3080`——与原版界面一致（参见 [Web UI 指南](docs/user/guide/index.md)）。如果 `3080` 被占用（例如官方 harness 正在运行），换一个端口：

```sh
pnpm dsh web --port 3199        # http://127.0.0.1:3199
```

模型/提供方选择在 GUI 设置中完成（存储于 `~/.dsh/settings.yaml`）；凭证来自 `~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY` 环境变量。

### 命令行一次性任务

```sh
pnpm dsh --profile headless "总结一下本仓库的 README"
```

### 无 API key 试玩（仓库自带 mock LLM）

```sh
pnpm mock:llm --sequence success --repeat-last                     # 终端 1
$env:DEEPSEEK_API_KEY = "mock"; $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:8000/v1"
pnpm dsh --profile headless "Say exactly: hello from pi loop"      # 终端 2
```

## 如何从原版 DeepSeek Harness 嵌入 PI 内核（移植指南）

在并列目录中放置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原版与 `pi/` 源码（Node ≥ 22.19，pnpm ≥ 11），按以下步骤复现 `deepseek-pi`：

1. **复制骨架**（不含 VCS 历史、构建产物与依赖）：

   ```powershell
   robocopy deepseek-harness deepseek-pi /E /XD .git node_modules lib dist coverage /XF *.tsbuildinfo
   ```

2. **Vendoring PI 内核**到 `vendor/`（沿用现有 vendor 模式；所有本地改动记录在 `vendor/README.md`）：

   - `vendor/pi-ai/`（`@deepseek-pi/pi-ai`，private）——`pi/packages/ai/src` 的精简子集：`types.ts`（provider option 类型换为宽松 stub、`typebox` 的 `TSchema`/`Static` 换为结构替身）、`utils/event-stream.ts`（原样）、`utils/validation.ts`（不依赖 TypeBox 的轻量 `validateToolArguments`——参数校验交给 `dsh-tools`）、精简 `index.ts` 只导出 agent core 所需词汇。不 vendor 任何 provider SDK 与 TypeBox 运行时。
   - `vendor/pi-agent-core/`（`@deepseek-pi/pi-agent-core`，private）——`pi/packages/agent/src` 的 `types.ts` / `agent.ts` / `agent-loop.ts` / `stream-fn.ts`，把 `@earendil-works/pi-ai` 与 `typebox` 的 import 重定向到 `@deepseek-pi/pi-ai`；精简 `index.ts` 导出 `Agent` 类、`runAgentLoop`/`runAgentLoopContinue` 与循环/类型词汇。
   - 每个 vendored 包配 `package.json`（`"type": "module"`，`main`/`types` → `src/index.ts`）、`tsconfig.json`（extends `../../tsconfig.base.json`，`rootDir: src`，`outDir: lib/types`）、`LICENSE`（PI 的 MIT）与 `README.md`。

3. **工作区接线**：

   - 根 `package.json` workspaces 已含 `vendor/*`，无需修改。
   - `tsconfig.base.json` 的 `paths` 增加 `"@deepseek-pi/pi-ai": ["./vendor/pi-ai/src"]` 与 `"@deepseek-pi/pi-agent-core": ["./vendor/pi-agent-core/src"]`。
   - `packages/core/agent-loop/package.json` 增加两个 `@deepseek-pi/*` workspace 依赖；`packages/core/agent-loop/tsconfig.json` 增加两个 vendor project reference。

4. **替换驱动器**（`packages/core/agent-loop/src/`）：

   - 删除 `agent.ts`、`tool-calls.ts`、`runtime-context.ts`（`ReactLoopAgent` 驱动器及其调度器）。
   - 新增 `pi-model.ts`（pi-ai `Model` shim + pi-ai ↔ harness 消息转换）、`pi-stream.ts`（PI `StreamFn` 由 harness LLM 接缝供数——`ctx.llm.prepareCall` 仅一次、请求消息用 `session.deriveMessages()` 保证身份一致、`request/header`/`request/context` 记账、`markAgentLoopRequest` + `deepFreeze`）、`pi-tools.ts`（`ToolSchema` → PI `AgentTool`，执行委托回 `ToolRuntime.execute`）、`pi-agent.ts`（`PiLoopAgent` 实现 harness 的 `Agent` 接口，驱动 PI `runAgentLoop` 并把事件投影到持久会话日志）。
   - `index.ts` 中把 `ReactLoopAgent` 替换为 `PiLoopAgent`——插件契约（`AgentLoop` 服务、`AgentFactory`、`agent/*` 事件词汇）保持不变，所有消费方（ACP、子代理、UI）零改动。

5. **测试**：删除 12 个上游 `ReactLoopAgent` spec（loop、tool-calls、tool-order、cancel、interception、request-error、request-reconstruction、coverage-edges、agent-initiator、resume、agent、config-session-id），新增 `tests/pi-loop.spec.ts` 覆盖 PI 循环的 turn 投影、工具往返、max-tokens、steer/followup、cancel、inject 语义。

6. **验证**（需网络）：

   ```powershell
   pnpm install
   pnpm run build:lib:host          # 编译被替换的循环 + 整个 harness
   pnpm run test:gui                # client/host GUI 套件（3783 个测试）
   pnpm run build:lib:client        # client 面 lib（含 lib/styles）
   pnpm run build:web               # web 前端
   pnpm dsh web --port 3199         # Web GUI（3080 是原版 harness 的端口）

   # 无 key 端到端冒烟：
   pnpm mock:llm --sequence success --repeat-last          # 终端 1
   $env:DEEPSEEK_API_KEY = "mock"; $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:8000/v1"
   pnpm dsh --profile headless "Say exactly: hello from pi loop"   # 终端 2
   ```

7. **了解差异**：阅读 `packages/core/agent-loop/README.md` 的 Known Limitations——turn 粒度（每次助手响应对应一个 harness turn）、串行工具执行（`maxParallelToolCalls` 接受但未强制）、无 `assistant/chunk` 流式增量、`agent/request-error` 重试恢复尚未接入、图像内容在块边界被丢弃。

## 许可证

[MIT](LICENSE)——DeepLoop 由 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 骨架（© 2026 DeepSeek）与 [PI agent loop](https://github.com/earendil-works/pi)（© 2025 Mario Zechner）组合而成，两处上游 MIT 声明均予保留。vendored 与运行时第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
