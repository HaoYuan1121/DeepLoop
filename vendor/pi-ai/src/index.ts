/**
 * @deepseek-pi/pi-ai — vendored minimal subset of `@earendil-works/pi-ai`.
 *
 * Exports exactly the vocabulary the vendored `@deepseek-pi/pi-agent-core`
 * consumes: message/model/tool/context types, the assistant event protocol,
 * `EventStream` / `AssistantMessageEventStream`, and `validateToolArguments`.
 *
 * @module @deepseek-pi/pi-ai
 */

export type { Static, TSchema } from './types.ts'
export * from './types.ts'
export * from './event-stream.ts'
export * from './validation.ts'
