# DeepLoop

English | [中文](README.zh.md)

**DeepLoop = DeepSeek Harness skeleton + PI's agent loop (loop engineering).**

DeepLoop is a derivative of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in which the harness's own agent driver (`ReactLoopAgent` in `packages/core/agent-loop`) is replaced by PI's agent engine — the "loop engineering" approach of [Pi Coding Agent](https://github.com/earendil-works/pi) — vendored as `@deepseek-pi/pi-agent-core` (+ `@deepseek-pi/pi-ai`) under `vendor/`.

DeepLoop inherits the DeepSeek Harness foundation unchanged except for the agent loop. See:
- [docs/pi-agent-swap-analysis.md](docs/pi-agent-swap-analysis.md) — the feasibility analysis (why the swap is sound, interface mapping, risks).
- [packages/core/agent-loop/README.md](packages/core/agent-loop/README.md) — the swapped loop: `PiLoopAgent` adapter, `pi-model` / `pi-stream` / `pi-tools` bridges, and known limitations.
- [vendor/README.md](vendor/README.md) — the vendored PI packages manifest and local-modification log.

Status: source-level swap complete and verified end-to-end (build, `test:gui`, rewritten agent-loop suite, headless smoke against the mock LLM, web GUI). Full test suite: 12434 pass / 204 fail — the failures are downstream specs asserting the old loop's exact semantics (ACP/subagent/goal/retry/compaction/plan) plus Windows-environmental issues; see the analysis doc §6.2 and the agent-loop README's Known Limitations.

## Quick start

DeepLoop is a source checkout — it is not published to npm, so run it from source only.

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 22.19
- [pnpm](https://pnpm.io) ≥ 11

### Clone, install, and build

```sh
git clone https://github.com/HaoYuan1121/DeepLoop.git
cd DeepLoop
pnpm install
pnpm run build
```

`pnpm run build` produces everything in one pass: `tsc` emits TypeScript declarations to `lib/types`, `tsdown` bundles the runtime, and `vite` builds the web frontend.

### Web UI

```sh
pnpm dsh web
```

Starts the Web UI at `http://127.0.0.1:3080` by default — the same interface as upstream's (see [Web UI guide](docs/user/guide/index.md)). If port `3080` is already taken (for example by the upstream harness running alongside), pick another port:

```sh
pnpm dsh web --port 3199        # http://127.0.0.1:3199
```

Model and provider selection live in the GUI's settings (stored in `~/.dsh/settings.yaml`); credentials come from `~/.dsh/.credentials.yaml` or the `DEEPSEEK_API_KEY` environment variable.

### Headless one-shot task

```sh
pnpm dsh --profile headless "summarize this repository's README"
```

### Try it without an API key (bundled mock LLM)

```sh
pnpm mock:llm --sequence success --repeat-last                     # terminal 1
DEEPSEEK_API_KEY=mock DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 \
  pnpm dsh --profile headless "Say exactly: hello from pi loop"    # terminal 2
```

## Configuration

Model/provider selection lives in the GUI settings (`~/.dsh/settings.yaml`). Credentials come from `~/.dsh/.credentials.yaml` or the `DEEPSEEK_API_KEY` environment variable. See [docs/user/guide/providers.md](docs/user/guide/providers.md) for supported providers and their configuration.

## Why this swap

The swap combines the strengths of both projects:
- **PI's agent loop completes most tasks well.** In practice pi-agent's loop engineering finishes the large majority of tasks successfully, with high efficiency and little per-turn overhead.
- **DeepSeek Harness keeps a high KV-cache hit rate.** Its session log folds request headers and appends events incrementally, so each request reuses already-cached context for most of its content.

Driving the harness's cache-friendly session layer with PI's loop is expected to cut token usage substantially: the loop sends fewer, leaner requests, and the harness maximizes cached-context reuse. The saving is a hypothesis, not yet measured — the actual experience awaits real users.

## How this fork was made (porting guide)

Steps to reproduce `deepseek-pi` from an upstream checkout of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (sibling dirs: `deepseek-harness/`, `pi/`; Node ≥ 22.19, pnpm ≥ 11).

1. **Copy the skeleton** (no VCS history, build output, or deps):

   ```powershell
   robocopy deepseek-harness deepseek-pi /E /XD .git node_modules lib dist coverage /XF *.tsbuildinfo
   ```

2. **Vendor the PI kernel** under `vendor/` (follow the existing vendoring pattern; every local divergence is logged in `vendor/README.md`):

   - `vendor/pi-ai/` (`@deepseek-pi/pi-ai`, private) — a trimmed subset of `pi/packages/ai/src`: `types.ts` (provider option bags replaced with loose stubs, `typebox`'s `TSchema`/`Static` replaced with structural stand-ins), `utils/event-stream.ts` (verbatim), `utils/validation.ts` (replacement `validateToolArguments` without TypeBox — argument validation stays in `dsh-tools`), and a trimmed `index.ts` exporting only what the agent core consumes. No provider SDKs, no TypeBox runtime.
   - `vendor/pi-agent-core/` (`@deepseek-pi/pi-agent-core`, private) — `pi/packages/agent/src` files `types.ts` / `agent.ts` / `agent-loop.ts` / `stream-fn.ts`, with `@earendil-works/pi-ai` and `typebox` import specifiers rescoped to `@deepseek-pi/pi-ai`; a trimmed `index.ts` exporting the `Agent` class, `runAgentLoop`/`runAgentLoopContinue`, and the loop/types vocabulary.
   - Each vendored package gets `package.json` (`"type": "module"`, `main`/`types` → `src/index.ts`), `tsconfig.json` (extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: lib/types`), `LICENSE` (PI's MIT), and a `README.md`.

3. **Wire the workspace**:

   - Root `package.json` workspaces already include `vendor/*` — no change needed.
   - `tsconfig.base.json` `paths` — add `"@deepseek-pi/pi-ai": ["./vendor/pi-ai/src"]` and `"@deepseek-pi/pi-agent-core": ["./vendor/pi-agent-core/src"]`.
   - `packages/core/agent-loop/package.json` — add both `@deepseek-pi/*` workspace deps; `packages/core/agent-loop/tsconfig.json` — add both vendor project references.

4. **Swap the driver** in `packages/core/agent-loop/src/`:

   - Delete `agent.ts`, `tool-calls.ts`, `runtime-context.ts` (the `ReactLoopAgent` driver and its scheduler).
   - Add `pi-model.ts` (pi-ai `Model` shim + pi-ai ↔ harness message converters), `pi-stream.ts` (PI `StreamFn` served from the harness LLM seam — `ctx.llm.prepareCall` once, `session.deriveMessages()` for request identity, `request/header`/`request/context` logging, `markAgentLoopRequest` + `deepFreeze`), `pi-tools.ts` (`ToolSchema` → PI `AgentTool`, execution delegated back to `ToolRuntime.execute`), and `pi-agent.ts` (`PiLoopAgent` implementing the harness `Agent` interface while driving PI's `runAgentLoop` and projecting events onto the durable session log).
   - In `index.ts`, replace `ReactLoopAgent` with `PiLoopAgent` — the plugin contract (`AgentLoop` service, `AgentFactory`, `agent/*` event vocabulary) stays identical, so all consumers (ACP, subagents, UI) keep working unchanged.

5. **Tests**: delete the 12 upstream `ReactLoopAgent` specs (loop, tool-calls, tool-order, cancel, interception, request-error, request-reconstruction, coverage-edges, agent-initiator, resume, agent, config-session-id) and add `tests/pi-loop.spec.ts` covering the PI loop's turn projection, tool round-trip, max-tokens, steer/followup, cancel, and inject semantics.

6. **Verify** (needs network):

   ```powershell
   pnpm install
   pnpm run build:lib:host          # compiles the swapped loop + whole harness
   pnpm run test:gui                # client/host GUI suites (3783 tests)
   pnpm run build:lib:client        # client-face libs (incl. lib/styles)
   pnpm run build:web               # web frontend
   pnpm dsh web --port 3199         # web GUI (port 3080 is the upstream harness's)

   # keyless end-to-end smoke:
   pnpm mock:llm --sequence success --repeat-last          # terminal 1
   $env:DEEPSEEK_API_KEY = "mock"; $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:8000/v1"
   pnpm dsh --profile headless "Say exactly: hello from pi loop"   # terminal 2
   ```

7. **Know the differences**: read `packages/core/agent-loop/README.md` (Known Limitations) — turn granularity (one harness turn per assistant response), sequential tool execution (`maxParallelToolCalls` accepted but not enforced), no streamed `assistant/chunk` deltas, no `agent/request-error` retry recovery yet, image content dropped at the block boundary.

## License

[MIT](LICENSE) — DeepLoop combines the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) skeleton (© 2026 DeepSeek) and the [PI agent loop](https://github.com/earendil-works/pi) (© 2025 Mario Zechner); both upstream MIT notices are preserved. Vendored and runtime third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
