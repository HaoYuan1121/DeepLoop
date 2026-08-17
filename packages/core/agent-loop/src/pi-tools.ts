/**
 * Bridge harness tool definitions into PI `AgentTool` values.
 *
 * The PI loop executes tools through its own `AgentTool.execute` contract; the
 * harness owns the real policy pipeline (`tools/pre-execute` → guard →
 * `tools/execute` → `tools/post-execute` → `tools/result`). The bridge keeps
 * the harness pipeline authoritative: every PI tool call dispatches through
 * `ToolRuntime.execute`, and policy denials arrive as harness failure results
 * that the bridge surfaces as thrown errors (the PI loop converts thrown
 * errors into `isError` tool results).
 *
 * @module dsh-agent-loop/pi-tools
 */

import type { Agent as DshAgent } from '@deepseek-ai/dsh-agent'
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@deepseek-pi/pi-agent-core'
import type { Context } from '@deepseek-ai/cordis'
import type { TSchema } from '@deepseek-pi/pi-ai'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult, ToolRuntime } from '@deepseek-ai/dsh-tools'

/** Map harness result content blocks to pi-ai text content. */
function resultContentToPi(content: readonly ContentBlock[]): { type: 'text'; text: string }[] {
  return content.flatMap((block): { type: 'text'; text: string }[] => {
    switch (block.type) {
      case 'text': return [{ type: 'text', text: block.text }]
      case 'tool-result': return resultContentToPi(block.content)
      case 'reasoning':
      case 'tool-call':
      case 'image':
        // TODO(pi-agent): pi-ai tool results carry text/image content only;
        // harness reasoning/tool-call/image blocks are dropped from results.
        return []
    }
  })
}

/**
 * Bridge one harness `ToolSchema` into a PI `AgentTool` that dispatches
 * through the harness tool pipeline.
 * @param _ctx - loop context (unused today; the tool runtime carries the registry).
 * @param agent - the driving harness agent (set as `ToolExecutionInput.agent`).
 * @param schema - the assembled tool schema (name/description/JSON-schema parameters).
 * @param tools - the tool runtime used for execution.
 * @returns a PI `AgentTool` whose execution is the harness pipeline.
 */
export function bridgeTool(_ctx: Context, agent: DshAgent, schema: ToolSchema, tools: ToolRuntime): AgentTool<any> {
  const name = schema.name
  return {
    name,
    label: schema.name,
    description: schema.description,
    parameters: schema.parameters as TSchema,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<any>> => {
      const result: ToolExecutionResult = await tools.execute({
        callId: CallId(toolCallId),
        name,
        arguments: params,
        agent,
        signal: signal ?? new AbortController().signal,
      })
      const content = resultContentToPi(result.content)
      if (result.isError) {
        // The PI loop converts thrown errors into isError tool results.
        throw new Error(content[0]?.text ?? `tool ${name} failed`)
      }
      return {
        content,
        details: result.meta ?? {},
        ...result.concludesTurn === true ? { terminate: true } : {},
      }
    },
  }
}

/**
 * Bridge the assembled tool schemas for one agent into PI `AgentTool` values.
 * @param ctx - loop context carrying the tool registry.
 * @param agent - the driving harness agent.
 * @param schemas - the agent-scoped assembled tool schemas.
 * @returns PI `AgentTool` values ordered like the schemas.
 */
export function bridgeTools(ctx: Context, agent: DshAgent, schemas: readonly ToolSchema[]): AgentTool<any>[] {
  const tools = ctx.tools
  return schemas.map(schema => bridgeTool(ctx, agent, schema, tools))
}
