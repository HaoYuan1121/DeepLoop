/**
 * PI stream-function bridge: serves the PI agent loop's `StreamFn` contract
 * from the DeepSeek Harness LLM seam.
 *
 * The harness direction (pi-ai events → harness chunks) is the existing
 * `dsh-llm-pi-ai` adapter; this module is the reverse (harness chunks →
 * pi-ai events) so the PI loop can be the driver while the harness LLM seam
 * (any adapter: deepseek, pi-ai, middleware) serves the model call.
 *
 * Every request is built, frozen, and logged exactly like the harness's own
 * loop (`markAgentLoopRequest` + `request/header` / `request/context`
 * events), keeping the `dsh-agent-loop/invariant` request-reconstruction
 * companion and the KV-cache-friendly log properties intact.
 *
 * @module dsh-agent-loop/pi-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StreamFn } from '@deepseek-pi/pi-agent-core'
import type { Api, AssistantMessage as PiAssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context as PiContext, Model, SimpleStreamOptions, TextContent, ThinkingContent, ToolCall, Usage as PiUsage } from '@deepseek-pi/pi-ai'
import { createAssistantMessageEventStream } from '@deepseek-pi/pi-ai'
import type { ContentBlock, GenerateOptions, LlmCallConfig, PreparedLlmCall, StreamChunk, ToolSchema, TokenUsage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, deepFreeze, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

/** Dependencies the stream bridge closes over from the PiLoopAgent. */
export interface PiStreamDeps {
  /** Loop context carrying `llm` and the agent registry. */
  readonly ctx: Context
  /** The driven session; its log is the durable source of truth. */
  readonly session: Session
  /** The declared provider/model route and output cap. */
  readonly options: AgentOptions
}

/** Map harness usage to pi-ai usage (pi-ai folds reasoning into output). */
function toPiUsage(usage: TokenUsage): PiUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Map harness content blocks to pi-ai assistant content. */
function blocksToPiContent(blocks: readonly ContentBlock[]): (TextContent | ThinkingContent | ToolCall)[] {
  return blocks.flatMap((block): (TextContent | ThinkingContent | ToolCall)[] => {
    switch (block.type) {
      case 'text': return [{ type: 'text', text: block.text }]
      case 'reasoning': return [{ type: 'thinking', thinking: block.text }]
      case 'tool-call': return [{
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseRawArguments(block.arguments),
      }]
      case 'tool-result':
      case 'image':
        // TODO(pi-agent): assistant-side images and nested results are not
        // produced by current adapters; dropped from the pi-ai message.
        return []
    }
  })
}

/** Parse raw JSON tool arguments, tolerating malformed text (the model may truncate). */
function parseRawArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Convert PI agent tools (their schemas) to harness `ToolSchema[]`. */
export function piToolsToSchemas(tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>): ToolSchema[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: (tool.parameters ?? {}) as Record<string, unknown>,
  }))
}

/**
 * Build the frozen, header-logged harness request for one PI loop model call.
 * Mirrors the harness loop's own `buildRequest` bookkeeping: `request/header`
 * is appended on the initial call and on change, `request/context` follows
 * provider/model/context-window changes, and the request is deep-frozen and
 * marked as loop-built for the invariant companion.
 * @param deps - bridge dependencies.
 * @param piContext - the PI loop's assembled context (system prompt, messages, tools).
 * @param options - stream options forwarded by the PI loop (signal, apiKey, ...).
 * @returns the frozen request plus the prepared call (single-dispatch) and logged config.
 */
async function buildHarnessRequest(
  deps: PiStreamDeps,
  piContext: PiContext,
  options: SimpleStreamOptions | undefined,
): Promise<{ request: GenerateOptions; config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
  const { ctx, session, options: agentOptions } = deps
  const signal = options?.signal ?? new AbortController().signal
  const provider = agentOptions.provider ?? ''
  const model = agentOptions.model ?? ''
  if (!provider || !model) {
    throw new Error(`agent "${session.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model`)
  }

  const proposed: LlmCallConfig = {
    provider,
    model,
    ...agentOptions.maxTokens === undefined ? {} : { maxTokens: agentOptions.maxTokens },
  }
  let config: LlmCallConfig = proposed
  let preparedCall: PreparedLlmCall | undefined
  try {
    preparedCall = await ctx.llm.prepareCall(proposed, signal)
    config = preparedCall.config
  } catch {
    // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
    config = proposed
  }
  signal.throwIfAborted()

  const system = piContext.systemPrompt ?? ''
  const tools = piToolsToSchemas(piContext.tools ?? [])
  // Model-visible ⟺ logged: the request messages MUST be the exact durable
  // derivation (identity included), or the request-reconstruction invariant
  // flags a log desync. The PI transcript mirrors the session surface
  // (pi-agent.ts projects every accepted message), so the log is the
  // authoritative source for the request boundary.
  const messages = session.deriveMessages()
  const header = canonicalHeader({
    config,
    ...system ? { system } : {},
    ...tools.length > 0 ? { tools } : {},
  })
  const baseline = session.requestHeader()
  session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'change' })

  const previousContext = session.requestContext()
  const contextWindow = previousContext?.contextWindow
  if (previousContext?.provider !== config.provider || previousContext.model !== config.model
    || previousContext.contextWindow !== contextWindow) {
    session.append('request/context', {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    })
  }
  signal.throwIfAborted()

  const request = markAgentLoopRequest(deepFreeze({
    ...config,
    messages,
    ...system ? { system } : {},
    ...tools.length > 0 ? { tools } : {},
    sessionId: session.id,
    signal,
  }))
  return { request, config, ...preparedCall === undefined ? {} : { preparedCall } }
}

/** Map a harness finish reason to the pi-ai terminal event type. */
function finishToPiEvents(
  assembler: BlockAssembler,
  config: LlmCallConfig,
  usage: PiUsage,
): AssistantMessageEvent {
  const blocks = assembler.blocks()
  const content = blocksToPiContent(blocks)
  const base: Omit<PiAssistantMessage, 'stopReason'> = {
    role: 'assistant',
    content,
    api: 'pi-messages',
    provider: config.provider,
    model: config.model,
    usage,
    timestamp: Date.now(),
  }
  const finish = assembler.finish
  switch (finish.kind) {
    case 'stop':
      return { type: 'done', reason: 'stop', message: { ...base, stopReason: 'stop' } }
    case 'tool-calls':
      return { type: 'done', reason: 'toolUse', message: { ...base, stopReason: 'toolUse' } }
    case 'max-tokens':
      return { type: 'done', reason: 'length', message: { ...base, stopReason: 'length' } }
    case 'aborted':
      return {
        type: 'error',
        reason: 'aborted',
        error: {
          ...base,
          stopReason: 'aborted',
          errorMessage: finish.failure?.message ?? 'harness stream aborted',
        },
      }
    case 'error':
      return {
        type: 'error',
        reason: 'error',
        error: {
          ...base,
          stopReason: 'error',
          errorMessage: finish.failure?.message ?? 'harness stream error',
        },
      }
  }
}

/**
 * Create the `StreamFn` the PI agent loop calls for every model request.
 * @param deps - bridge dependencies.
 * @returns a function satisfying `@deepseek-pi/pi-agent-core`'s `StreamFn`.
 */
export function createPiStreamFn(deps: PiStreamDeps): StreamFn {
  return (model: Model<Api>, piContext: PiContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      try {
        const signal = options?.signal
        const { request, config, preparedCall } = await buildHarnessRequest(deps, piContext, options)
        signal?.throwIfAborted()
        // A prepared call is single-dispatch and config-checked; use it exactly
        // once (the harness loop's own dispatch pattern), falling back to the
        // runtime stream for unregistered (middleware-served) routes.
        const chunks = preparedCall?.stream(request) ?? deps.ctx.llm.stream(request)
        const assembler = new BlockAssembler()
        // TODO(pi-agent): emit progressive text/thinking/toolcall deltas as they
        // arrive so the transcript streams; the current bridge emits the
        // terminal event only, which the PI loop renders as one message.
        // The harness stream normalizes abort into a terminal `finish` chunk, so
        // the loop must NOT throw on the aborted signal mid-iteration — that
        // would swallow the terminal chunk and misreport the turn as an error.
        for await (const chunk of chunks as AsyncIterable<StreamChunk>) {
          assembler.push(chunk)
        }
        const usage = assembler.usage === undefined
          ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
          : toPiUsage(assembler.usage)
        stream.push(finishToPiEvents(assembler, config, usage))
      } catch (error: unknown) {
        const failure: PiAssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'pi-messages',
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        }
        stream.push({ type: 'error', reason: 'error', error: failure })
      }
    })()
    return stream
  }
}
