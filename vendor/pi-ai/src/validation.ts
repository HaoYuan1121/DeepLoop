import type { Tool, ToolCall } from './types.ts'

/**
 * Materialize validated tool-call arguments for execution.
 *
 * LOCAL MODIFICATION vs upstream `packages/ai/src/utils/validation.ts` (see
 * vendor/README.md): upstream validates against the tool's TypeBox schema
 * (`typebox/compile` + `typebox/value`). No TypeBox runtime is vendored; the
 * DeepSeek Harness tool pipeline (`@deepseek-ai/dsh-tools` `ToolRuntime`) owns
 * argument validation for DSH-defined tools, so this shim only rejects
 * non-object arguments and returns the parsed object untouched.
 * @param tool - the target tool definition.
 * @param toolCall - the raw tool call whose `arguments` are already parsed.
 * @returns the parsed arguments object.
 * @throws when arguments are not a plain object.
 */
export function validateToolArguments(tool: Tool, toolCall: Pick<ToolCall, 'arguments'>): unknown {
  const args = toolCall.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Tool ${tool.name} requires an object of arguments`)
  }
  return args
}
