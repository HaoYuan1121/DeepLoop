# @deepseek-pi/pi-agent-core (vendored)

Minimal vendored subset of [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core),
rescoped to `@deepseek-pi/pi-agent-core` and used as the loop engine of
`@deepseek-ai/dsh-agent-loop` in deepseek-pi.

Vendored files (from `pi/packages/agent/src`, upstream pi-mono):

- `types.ts` — agent message/tool/loop/event vocabulary
- `agent.ts` — the stateful `Agent` class (steering/follow-up queues, events)
- `agent-loop.ts` — `agentLoop` / `agentLoopContinue` / `runAgentLoop*` and the
  turn/tool execution machinery
- `stream-fn.ts` — default stream-function slot (`setDefaultStreamFn`)

Local modifications (see `vendor/README.md` for the log):

- Imports of `@earendil-works/pi-ai` and `typebox` are rescoped to
  `@deepseek-pi/pi-ai`.
- `index.ts` exports only the core loop surface; upstream also exports the
  `harness/`, compaction, session, search, proxy, and telemetry surfaces,
  which are not vendored.

License: MIT (upstream `pi/LICENSE`).
