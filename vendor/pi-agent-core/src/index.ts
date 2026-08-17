// Vendored minimal core of @earendil-works/pi-agent-core, rescoped as
// @deepseek-pi/pi-agent-core. LOCAL MODIFICATION vs upstream
// packages/agent/src/index.ts (see vendor/README.md): only the stateful Agent
// class, the low-level loop functions, and the loop/types vocabulary are
// exported; the harness/, compaction/, session-backend, search/, proxy/, and
// telemetry surfaces are not vendored.

export * from './agent.ts'
export * from './agent-loop.ts'
export * from './types.ts'
export { setDefaultStreamFn, getDefaultStreamFn } from './stream-fn.ts'
