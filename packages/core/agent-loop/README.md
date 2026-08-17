# dsh-agent-loop

English | [中文](README.zh.md)

THE concrete agent plugin and loop driver — in deepseek-pi, driven by the **PI agent loop** ("loop engineering") vendored as `@deepseek-pi/pi-agent-core`. The `PiLoopAgent` adapter satisfies the `Agent` interface and drives the session/turn/step lifecycle through PI's `runAgentLoop`, while the harness LLM seam, tool pipeline, and session log stay authoritative.

This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension points — new behavior goes into plugins, not here.

## Service: `AgentLoop` (ctx key: `agentLoop`)

The service contract is unchanged from upstream: creation and resume are one rollback-covered transaction that constructs a private session, a concrete agent, and a scoped context; publishes through both registries; and owns ordered teardown. What changed is the concrete driver and its loop engine:

- **Driver**: `PiLoopAgent` (replaces `ReactLoopAgent`).
- **Loop engine**: the vendored PI `runAgentLoop` (see [vendor/README.md](../../../vendor/README.md) for the vendoring manifest and local modifications).
- **Model calls**: the PI loop's `StreamFn` contract is served from the harness LLM seam (`ctx.llm.prepareCall` + adapter `stream`), so any harness adapter (deepseek, pi-ai, middleware) serves the call. Requests are deep-frozen, `markAgentLoopRequest`-marked, and `request/header` / `request/context`-logged exactly like the upstream loop, keeping the `dsh-agent-loop/invariant` request-reconstruction companion and KV-cache-friendly log properties.
- **Tools**: harness `ToolSchema`s are bridged into PI `AgentTool`s that dispatch through `ToolRuntime.execute`; the harness policy pipeline (`tools/pre-execute` → guard → `tools/execute` → `tools/post-execute` → `tools/result`) stays authoritative.
- **Inbox**: the harness inbox remains the single pending-work store. The PI loop's steering and follow-up polls drain it through the `agent/pre-step` waterfall, so compaction, guard, and other plugins see every proposed step.
- **Session log**: PI loop events are projected onto the durable session vocabulary (`turn/start` → `step/start` → `user/message` / `assistant/message` / `tool/call` + `tool/result` → `step/end` → `turn/end`). Each PI turn (one assistant response + its tool batch) maps to one harness turn with one step.

### Public API

Identical to upstream: `ctx.agentLoop.create(id, options?, meta?)`, `ctx.agents.create({...})` / `ctx.agents.resume({...})` via the `AgentFactory` contract. See [../agent/README.md](../agent/README.md) for the `Agent` interface.

### Configuration (schemastery)

Identical to upstream:

```ts
interface Config {
  maxParallelToolCalls?: number // default 10; accepted but not yet enforced by the PI loop (see Known Limitations)
  agents: Array<{
    id: string                 // required
    provider?: string
    model?: string
    maxTokens?: number
    resumeSessionId?: string
    cwd?: string
  }>
}
```

### Loop lifecycle (`pi-agent.ts`)

The driver owns one agent for its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`. `PiLoopAgent` mirrors the upstream phase machine (idle/maintenance/running, wake latching after abort, `whenIdle()` quiescence) and routes `followup`/`steer`/`inject` through the harness inbox with the same wake semantics.

Within one kick, the driver:

1. Assembles the agent world: `ctx.systemPrompt.assemble` → system prompt + agent-scoped tool schemas, bridged to PI `AgentTool`s.
2. Claims the pending batch (next-turn, falling back to next-step steering) and converts it to PI messages.
3. Runs `runAgentLoop(prompts, context, config, emit, signal, streamFn)`:
   - `context` = assembled system prompt, the PI transcript, and the bridged tools.
   - `config` = model shim, `convertToLlm`, `toolExecution: 'sequential'`, `getSteeringMessages`/`getFollowUpMessages` draining the harness inbox through `agent/pre-step`.
   - `emit` projects each PI event onto the durable session log.
   - `streamFn` serves the model call from the harness LLM seam.
4. Appends the run's new messages to the PI transcript (mirroring the durable surface).

### What belongs to plugins

Unchanged from upstream: hooks and policy on the `agent/*` checkpoints and the `tools/*` pipeline; compaction on `agent/pre-step`; model-request recovery on `agent/request-error`; sandbox/permission/plan mode on `tools/pre-execute`; sub-agents as `ctx.subagents` providers; persistence on `session/event`; UI on `session/event` + `agent/*` control events.

## Model Experience

### Complete conversation request

#### What the model sees

For each run, the PI loop sends the assembled per-agent system prompt, visible tool schemas, and the derived messages (the PI transcript seeded from the session surface plus the run's accepted inputs). It supplies `provider`, `model`, and `cwd` variable values but no additional fixed prose.

#### Token effect

System text and schemas are paid again on every step. Per-agent scoping chooses the contributions, while the authoritative assembly waterfall can alter the final request.

#### KV Cache effect

Append-only while system text, schemas, and earlier history remain byte-identical under the same provider and model route. The bridge rebuilds each request from the PI transcript; a transcript/session divergence (see Known Limitations) can invalidate reuse.

### Retained message history

#### What the model sees

Accepted user messages, assistant messages, tool calls and results, injected context, and steering are logged and sent on later runs. Raw stream chunks are not logged by the bridge (the harness chunk protocol is consumed inside `pi-stream.ts` and projected as one `assistant/message`).

#### Token effect

Input grows with every surface message until a compaction replacement shadows older nodes.

#### KV Cache effect

Ordinary history growth is append-only and preserves reusable entries.

## Known Limitations and Deferred Work

- **Turn granularity differs from upstream**: each PI turn maps to one harness turn with one step, so a tool loop that upstream kept in one turn becomes one harness turn per assistant response. Turn numbering and `turn/end` reasons differ from `ReactLoopAgent` sessions; a session log produced by one loop is not interchangeable with the other (the harness has no cross-format promise).
- **`maxParallelToolCalls` is not enforced**: the PI loop executes tool calls sequentially (`toolExecution: 'sequential'`) to preserve harness ordering guarantees; the setting is accepted for config compatibility but the bounded parallel pool of the upstream scheduler is not implemented.
- **Streaming deltas are not projected**: `pi-stream.ts` buffers the harness chunk stream and emits the terminal event only; the transcript does not stream token deltas (`assistant/chunk` events are not written).
- **Runtime context projection deferred**: the upstream `RuntimeContextProjection` (context sections injected per step) is not replicated; the PI loop carries one static system prompt per run.
- **Image content is dropped** at the pi-ai ↔ harness block boundary (harness images are attachment refs; pi-ai carries inline base64); image-free sessions round-trip losslessly.
- **Resume is a lossy projection**: `dshMessagesToPi` rebuilds the PI transcript from the session surface; unmappable messages (system role, images) are dropped.
- **The PI `Agent` class wrapper is not used**: the adapter drives the low-level `runAgentLoop` directly to keep the harness inbox/pre-step contract; PI's stateful `Agent` class and its queues are available to consumers of `@deepseek-pi/pi-agent-core` but are not the harness driver.
- **Tests**: the upstream `ReactLoopAgent` test suite does not apply to the PI loop; `tests/` retains the plugin-surface specs that still compile, and loop-behavior specs must be rewritten for the PI driver.
