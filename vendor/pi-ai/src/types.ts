/**
 * Minimal vendored subset of `@earendil-works/pi-ai` types, rescoped as
 * `@deepseek-pi/pi-ai`.
 *
 * LOCAL MODIFICATION vs upstream `packages/ai/src/types.ts` (see
 * vendor/README.md): provider option bags (`AnthropicOptions`, ...),
 * `TelemetryContext`, and `AssistantMessageDiagnostic` are replaced with loose
 * local stubs, and `typebox`'s `TSchema`/`Static` are replaced with structural
 * stand-ins. Only the message/model/tool/context/event vocabulary consumed by
 * `@deepseek-pi/pi-agent-core` is retained.
 *
 * @module @deepseek-pi/pi-ai
 */

/** Provider option bags are unused by the vendored agent core; keep loose stubs. */
export type AnthropicOptions = Record<string, unknown>
export type AzureOpenAIResponsesOptions = Record<string, unknown>
export type BedrockOptions = Record<string, unknown>
export type GoogleOptions = Record<string, unknown>
export type GoogleVertexOptions = Record<string, unknown>
export type MistralOptions = Record<string, unknown>
export type OpenAICodexResponsesOptions = Record<string, unknown>
export type OpenAICompletionsOptions = Record<string, unknown>
export type OpenAIResponsesOptions = Record<string, unknown>
export type PiMessagesOptions = Record<string, unknown>

/** Telemetry context stub; the vendored agent core performs no telemetry. */
export interface TelemetryContext {}

import type { AssistantMessageEventStream } from './event-stream.ts'

/** Redacted provider/runtime diagnostics; the vendored core never reads fields. */
export interface AssistantMessageDiagnostic {
  /** @internal stub */
  readonly [key: string]: unknown
}

/**
 * Structural stand-in for `typebox`'s `TSchema`. Tool schemas in this harness
 * are plain JSON Schema objects (see `@deepseek-ai/dsh-llm` `ToolSchema`);
 * TypeBox accepts those at runtime and no TypeBox runtime is vendored here.
 */
export interface TSchema {
  [Symbol.toStringTag]: string
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  items?: TSchema
  [key: string]: unknown
}

/** Structural stand-in for `typebox`'s `Static<T>`; callers keep explicit casts. */
export type Static<T extends TSchema> = unknown

export type KnownApi =
  | 'openai-completions'
  | 'mistral-conversations'
  | 'openai-responses'
  | 'azure-openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'bedrock-converse-stream'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'pi-messages'

export type Api = KnownApi | (string & {})

export type KnownImagesApi = 'openrouter-images'

export type ImagesApi = KnownImagesApi | (string & {})

export type KnownProvider =
  | 'amazon-bedrock'
  | 'ant-ling'
  | 'anthropic'
  | 'google'
  | 'google-vertex'
  | 'openai'
  | 'azure-openai-responses'
  | 'openai-codex'
  | 'radius'
  | 'nvidia'
  | 'deepseek'
  | 'github-copilot'
  | 'xai'
  | 'groq'
  | 'cerebras'
  | 'openrouter'
  | 'vercel-ai-gateway'
  | 'zai'
  | 'zai-coding-cn'
  | 'mistral'
  | 'minimax'
  | 'minimax-cn'
  | 'moonshotai'
  | 'moonshotai-cn'
  | 'huggingface'
  | 'fireworks'
  | 'together'
  | 'baseten'
  | 'opencode'
  | 'opencode-go'
  | 'kimi-coding'
  | 'cloudflare-workers-ai'
  | 'cloudflare-ai-gateway'
  | 'qwen-token-plan'
  | 'qwen-token-plan-cn'
  | 'qwen-token-plan-individual'
  | 'xiaomi'
  | 'xiaomi-token-plan-cn'
  | 'xiaomi-token-plan-ams'
  | 'xiaomi-token-plan-sgp'

export type ProviderId = KnownProvider | string

export type KnownImagesProvider = 'openrouter'

export type ImagesProviderId = KnownImagesProvider | string

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelThinkingLevel = 'off' | ThinkingLevel

export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>

export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
    $var: 'thinking.enabled' | 'thinking.effort'
    omitWhenOff?: boolean
  }

/** Token budgets for each thinking level (token-based providers only). */
export interface ThinkingBudgets {
  minimal?: number
  low?: number
  medium?: number
  high?: number
}

// Base options all providers share
export type CacheRetention = 'none' | 'short' | 'long'

export type Transport = 'sse' | 'websocket' | 'websocket-cached' | 'auto'

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>
export type ProviderHeaders = Record<string, string | null>
export type FetchFunction = typeof globalThis.fetch
export type SessionAffinityFormat = 'openai' | 'openai-nosession' | 'openrouter'

export interface ProviderResponse {
  status: number
  headers: Record<string, string>
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
export interface ProviderRequestOptions<TModel = Model<Api>> {
  apiKey?: string
  signal?: AbortSignal
  sessionId?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  onPayload?: (payload: unknown) => void
  onResponse?: (response: ProviderResponse) => void
  headers?: Record<string, string | null>
  env?: ProviderEnv
  fetch?: FetchFunction
  transport?: Transport
  cacheRetention?: CacheRetention
  sessionAffinity?: SessionAffinityFormat
  maxRetryDelayMs?: number
  /** @internal stub: upstream carries per-provider callbacks here. */
  callbacks?: Record<string, unknown>
  [key: string]: unknown
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
  deferred: { window?: '15m' | '1h' | '24h' }
}

export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel
  /** Ask a capable provider to return a durable handle and continue the request asynchronously. */
  deferred?: boolean | { window?: '15m' | '1h' | '24h' }
  /** Custom token budgets for thinking levels (token-based providers only). */
  thinkingBudgets?: ThinkingBudgets
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream

export interface TextSignatureV1 {
  v: 1
  id: string
  phase?: 'commentary' | 'final_answer'
}

export interface TextContent {
  type: 'text'
  text: string
  textSignature?: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, any>
  thoughtSignature?: string
  namespace?: string
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface DeferredHandle {
  provider: string
  modelId: string
  api: string
  id: string
  expiresAt?: number
  pollAfterMs?: number
  data?: JsonValue
}

export interface UserMessage {
  role: 'user'
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: Api
  provider: ProviderId
  model: string
  responseModel?: string
  responseId?: string
  diagnostics?: AssistantMessageDiagnostic[]
  usage: Usage
  stopReason: StopReason
  deferred?: DeferredHandle
  errorMessage?: string
  rawStopReason?: string
  endTurn?: boolean
  timestamp: number
}

export interface ToolResultMessage<TDetails = any> {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  usage?: Usage
  addedToolNames?: string[]
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
    type: 'done'
    reason: Extract<StopReason, 'stop' | 'length' | 'toolUse' | 'deferred'>
    message: AssistantMessage
  }
  | { type: 'error'; reason: Extract<StopReason, 'aborted' | 'error'>; error: AssistantMessage }

/**
 * Optional provider-side constrained sampling configs for a tool. Retained for
 * structural parity with upstream; the vendored loop ignores it.
 */
export type ConstrainedSamplingConfig =
  | { type: 'json_schema'; strict: 'prefer' | 'require' }
  | { type: 'grammar'; variants: Record<string, string> }

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string
  description: string
  parameters: TParameters
  constrainedSampling?: false | ConstrainedSamplingConfig
}

export interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[]
}

// Model interface for the unified model system
export interface Model<TApi extends Api> {
  id: string
  name: string
  api: TApi
  provider: ProviderId
  baseUrl: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
  input: ('text' | 'image')[]
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  samplingParams?: Record<string, unknown>
  headers?: Record<string, string>
  /** @internal stub: upstream carries provider-specific compat here. */
  compat?: Record<string, unknown>
}

export type { AssistantMessageEventStream } from './event-stream.ts'
