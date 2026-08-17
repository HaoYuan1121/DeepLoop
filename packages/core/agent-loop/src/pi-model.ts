/**
 * pi-ai model shim and message converters for the deepseek-pi loop bridge.
 *
 * The PI agent loop consumes pi-ai vocabulary (`Model`, `Message`, ...); the
 * DeepSeek Harness LLM seam produces its own vocabulary (`GenerateOptions`,
 * `Message`, `ContentBlock`). This module converts between the two at the
 * request boundary and provides the minimal `Model` object the PI loop needs.
 *
 * @module dsh-agent-loop/pi-model
 */

import type { Api, AssistantMessage as PiAssistantMessage, ImageContent, Message as PiMessage, Model, TextContent, ThinkingContent, ToolCall, ToolResultMessage as PiToolResultMessage, Usage as PiUsage, UserMessage as PiUserMessage } from '@deepseek-pi/pi-ai'
import type { AssistantMessage as DshAssistantMessage, ContentBlock, Message as DshMessage, ToolResultMessage as DshToolResultMessage, UserMessage as DshUserMessage } from '@deepseek-ai/dsh-llm'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Zero-cost usage placeholder for pi-ai messages reconstructed from the log. */
const EMPTY_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Build the minimal pi-ai `Model` the PI loop routes on. The harness LLM seam
 * resolves the real adapter registration at request time from `provider` /
 * `model`; the pi-ai model object only carries that route plus metadata.
 * @param provider - harness provider route.
 * @param model - harness model id.
 * @param maxTokens - optional output cap.
 * @returns a pi-ai `Model` value satisfying the loop's read surface.
 */
export function createPiModel(provider: string, model: string, maxTokens?: number): Model<Api> {
  return {
    id: model,
    name: model,
    api: 'pi-messages',
    provider,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: maxTokens ?? 0,
  }
}

/** Map one pi-ai content block to its harness block, or undefined when unmappable. */
function piContentToDsh(block: TextContent | ThinkingContent | ToolCall | ImageContent): ContentBlock | undefined {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'thinking': return { type: 'reasoning', text: block.thinking }
    case 'toolCall': return {
      type: 'tool-call',
      id: CallId(block.id),
      name: block.name,
      // pi-ai carries parsed arguments; the harness vocabulary keeps raw JSON.
      arguments: JSON.stringify(block.arguments),
    }
    case 'image':
      // TODO(pi-agent): the harness represents images as attachment refs owned
      // by dsh-attachment; pi-ai carries base64 data inline. Bridging images
      // into a harness request requires materializing an attachment, which the
      // current adapters never produce on the assistant side.
      return undefined
  }
}

/** Any harness message the bridge can produce from pi-ai vocabulary. */
export type DshAnyMessage = DshUserMessage | DshAssistantMessage | DshToolResultMessage

/**
 * Convert one pi-ai message to the harness message vocabulary for a request.
 * @param message - pi-ai message from the PI loop context.
 * @param provider - provider route for assistant provenance.
 * @param model - model id for assistant provenance.
 * @returns the harness message, or undefined when no mappable content remains.
 */
export function piMessageToDsh(
  message: PiMessage,
  provider: string,
  model: string,
): DshAnyMessage | undefined {
  switch (message.role) {
    case 'user': {
      const content = typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content.map(piContentToDsh).filter((block): block is ContentBlock => block !== undefined)
      if (content.length === 0) return undefined
      return createUserMessage({ content, source: { kind: 'user' } })
    }
    case 'assistant': {
      const content = message.content.map(piContentToDsh).filter((block): block is ContentBlock => block !== undefined)
      return createAssistantMessage({ content, source: { provider, model } })
    }
    case 'toolResult': {
      const content = message.content.map(piContentToDsh).filter((block): block is ContentBlock => block !== undefined)
      return createToolResultMessage({
        callId: CallId(message.toolCallId),
        content,
        isError: message.isError,
      })
    }
  }
}

/** Map one harness content block to pi-ai content, or undefined when unmappable. */
function dshContentToPi(block: ContentBlock): TextContent | ThinkingContent | ToolCall | ImageContent | undefined {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'thinking', thinking: block.text }
    case 'tool-call': return {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: parseRawArguments(block.arguments),
    }
    case 'tool-result': return undefined
    case 'image':
      // TODO(pi-agent): harness image blocks reference attachments; pi-ai needs
      // inline base64. Logged image inputs cannot be replayed into the PI loop.
      return undefined
  }
}

/** Parse raw JSON tool arguments, tolerating malformed text (the model may truncate). */
function parseRawArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Whether one harness message maps to a pi-ai user message. */
function isDshUser(message: DshMessage): message is DshUserMessage {
  return message.role === 'user' && message.source.kind !== 'tool'
}

/** Whether one harness message maps to a pi-ai tool-result message. */
function isDshToolResult(message: DshMessage): message is DshToolResultMessage {
  return message.role === 'user' && message.source.kind === 'tool'
}

/** Whether one harness message maps to a pi-ai assistant message. */
function isDshAssistant(message: DshMessage): message is DshAssistantMessage {
  return message.role === 'assistant'
}

/**
 * Convert one harness message (from the session surface) to pi-ai vocabulary.
 * @param message - harness message.
 * @returns the pi-ai message, or undefined when unmappable (system role, images).
 */
export function dshMessageToPi(message: DshMessage): PiMessage | undefined {
  if (isDshUser(message)) {
    const content = message.content
      .map(dshContentToPi)
      .filter((block): block is TextContent | ImageContent => block?.type === 'text' || block?.type === 'image')
    const userMessage: PiUserMessage = { role: 'user', content, timestamp: Date.now() }
    return userMessage
  }
  if (isDshToolResult(message)) {
    const toolResultBlock = message.content[0]
    if (toolResultBlock === undefined || toolResultBlock.type !== 'tool-result') return undefined
    const content = toolResultBlock.content.map(dshContentToPi).filter((block): block is TextContent | ImageContent => block?.type === 'text' || block?.type === 'image')
    const toolResult: PiToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolResultBlock.toolCallId,
      toolName: '',
      content,
      isError: toolResultBlock.isError === true,
      timestamp: Date.now(),
    }
    return toolResult
  }
  if (isDshAssistant(message)) {
    const content = message.content.map(dshContentToPi).filter((block): block is TextContent | ThinkingContent | ToolCall => block !== undefined)
    const assistant: PiAssistantMessage = {
      role: 'assistant',
      content,
      api: 'pi-messages',
      provider: message.source.provider,
      model: message.source.model,
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    return assistant
  }
  return undefined
}

/**
 * Rebuild the pi-ai message list for a fresh or resumed PI loop from the
 * session surface. Messages that cannot map are dropped, so a resumed loop
 * context is a lossy projection of the durable log.
 * @param messages - harness messages derived from the session log.
 * @returns pi-ai messages for the PI agent state.
 */
export function dshMessagesToPi(messages: readonly DshMessage[]): PiMessage[] {
  return messages.map(dshMessageToPi).filter((message): message is PiMessage => message !== undefined)
}
