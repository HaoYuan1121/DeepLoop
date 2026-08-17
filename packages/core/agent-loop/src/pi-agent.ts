/**
 * PiLoopAgent: the deepseek-pi agent driver.
 *
 * Satisfies the harness `Agent` interface (registry, inbox, event taxonomy,
 * durable session log) while delegating the actual loop to PI's low-level
 * `runAgentLoop` — the "loop engineering" engine vendored as
 * `@deepseek-pi/pi-agent-core`. Everything observable still happens through
 * harness session events and `agent/*` notifications, so the plugin ecosystem
 * (compaction, guard, sandbox, subagents, UI) keeps working unchanged.
 *
 * The harness inbox is the single pending-work store; the PI loop's steering
 * and follow-up polls drain it through the `agent/pre-step` waterfall, so
 * compaction and guard plugins see every proposed step. The PI loop's
 * in-memory transcript (`piMessages`) mirrors the durable session surface and
 * is reseeded from it on resume.
 *
 * Turn/step mapping: the PI loop emits one `turn_start`/`turn_end` per
 * assistant response plus its tool batch; each such PI turn becomes one
 * harness turn containing exactly one step. The durable log keeps the
 * invariant shape (`turn/start` → `step/start` → `user/message` /
 * `assistant/message` / `tool/call` + `tool/result` → `step/end` → `turn/end`).
 *
 * @module dsh-agent-loop/pi-agent
 */

import type { AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from '@deepseek-pi/pi-agent-core'
import { runAgentLoop } from '@deepseek-pi/pi-agent-core'
import type { Message as PiMessage } from '@deepseek-pi/pi-ai'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createPiModel, dshMessagesToPi, piMessageToDsh, type DshAnyMessage } from './pi-model.ts'
import { createPiStreamFn } from './pi-stream.ts'
import { bridgeTools } from './pi-tools.ts'
import type { ToolResultMessage as DshToolResultMessage } from '@deepseek-ai/dsh-llm'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Whether a bridged message is a tool-result (tool source: only `createToolResultMessage` produces it here). */
function isToolResultMessage(message: DshAnyMessage | undefined): message is DshToolResultMessage {
  return message !== undefined && message.role === 'user' && message.source.kind === 'tool'
}

/** Map pi-ai usage to harness token accounting. */
function toTokenUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/**
 * Drives one session through the PI agent loop while presenting the harness
 * `Agent` contract.
 */
export class PiLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  /** PI loop transcript; mirrors the durable session surface. */
  private piMessages: PiMessage[]
  private lastCancelCause: AgentCancelCause | undefined
  /** Durable seq of each pending tool/call, paired to its tool/result. */
  private readonly toolCallSeqs = new Map<string, number>()
  private readonly streamFn: StreamFn

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.piMessages = dshMessagesToPi(session.deriveMessages())
    this.streamFn = createPiStreamFn({ ctx: loopCtx, session, options })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    this.lastCancelCause = cause
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /** Start one driver, or latch its wake behind maintenance or an aborted activity. */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Claim the pending batch for one wake: next-turn first, then any next-step steering. */
  private claimWakeBatch(): UserMessage[] {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const nextTurn = this.inbox.claim('next-turn', turn)
    const nextStep = nextTurn.length === 0 ? this.inbox.claim('next-step', turn) : []
    return [...nextTurn, ...nextStep]
  }

  /** Drain next-step steering through the pre-step waterfall (compaction/guard see it). */
  private async claimNextStep(): Promise<AgentMessage[]> {
    if (this.phase.kind !== 'running' || !this.inbox.nextStep.length) return []
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim('next-step', this.phase.turn)
    const decision = await this.runPreStep(claimed, signal)
    return this.toPiMessages(decision)
  }

  /** Drain the next-turn follow-up batch through the pre-step waterfall. */
  private async claimNextTurn(): Promise<AgentMessage[]> {
    if (!this.inbox.nextTurn.length) return []
    const signal = this.phase.kind === 'running' ? this.phase.abort.signal : new AbortController().signal
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const claimed = this.inbox.claim('next-turn', turn)
    const decision = await this.runPreStep(claimed, signal)
    return this.toPiMessages(decision)
  }

  /** Run the `agent/pre-step` waterfall; rejection yields no messages. */
  private async runPreStep(claimed: UserMessage[], signal: AbortSignal): Promise<PreStepDecision> {
    if (this.phase.kind !== 'running') {
      // Follow-up polled outside a run: no turn/step context, accept as-is.
      return claimed.length === 0 ? { kind: 'reject' } : { kind: 'enter', messages: claimed }
    }
    const { turn, step } = this.phase
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, turn, step, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: claimed }),
    )
    signal.throwIfAborted()
    return decision
  }

  /** Convert accepted harness messages to pi-ai messages for the loop. */
  private toPiMessages(decision: PreStepDecision): AgentMessage[] {
    if (decision.kind === 'reject') return []
    return decision.messages
      .map(message => dshMessagesToPi([message])[0])
      .filter((message): message is AgentMessage => message !== undefined)
  }

  /** Project one PI loop event onto the durable harness session log. */
  private projectEvent(event: AgentEvent): void {
    // PI events only arrive while the driver is running; the phase carries the
    // current turn/step numbers for the durable log.
    const phase = this.phase
    if (phase.kind !== 'running') return
    switch (event.type) {
      case 'turn_start': {
        const turn = phase.turn + 1
        phase.turn = turn
        phase.step = 1
        this.session.append('turn/start', { turn })
        this.session.append('step/start', { turn, step: 1 })
        break
      }
      case 'message_end': {
        const message = event.message
        const { turn, step } = phase
        if (message.role === 'user') {
          const converted = piMessageToDsh(message, this.options.provider ?? '', this.options.model ?? '')
          if (converted !== undefined && converted.role === 'user' && converted.source.kind === 'user') {
            this.session.append('user/message', converted, { surfaceOp: 'append' })
          }
        } else if (message.role === 'assistant') {
          const converted = piMessageToDsh(message, this.options.provider ?? '', this.options.model ?? '')
          if (converted !== undefined && converted.role === 'assistant') {
            const usage = toTokenUsage(message.usage)
            this.session.append(
              'assistant/message',
              {
                turn,
                step,
                message: converted,
                ...usage === undefined ? {} : { usage },
              },
              { surfaceOp: 'append' },
            )
          }
        } else if (message.role === 'toolResult') {
          const converted = piMessageToDsh(message, this.options.provider ?? '', this.options.model ?? '')
          if (isToolResultMessage(converted)) {
            const callSeq = this.toolCallSeqs.get(message.toolCallId)
            this.toolCallSeqs.delete(message.toolCallId)
            this.session.append(
              'tool/result',
              { turn, step, message: converted },
              { surfaceOp: 'append', ...callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] } },
            )
          }
        }
        break
      }
      case 'tool_execution_start': {
        const { turn, step } = phase
        const callEvent = this.session.append('tool/call', {
          turn,
          step,
          callId: CallId(event.toolCallId),
          name: event.toolName,
          arguments: JSON.stringify(event.args ?? {}),
        })
        this.toolCallSeqs.set(event.toolCallId, callEvent.seq)
        break
      }
      case 'turn_end': {
        const { turn, step } = phase
        this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason: this.turnEndReason(event) })
        break
      }
      case 'agent_end':
      case 'agent_start':
      case 'message_start':
      case 'message_update':
      case 'tool_execution_update':
      case 'tool_execution_end':
        // Log-only or no durable fact: nothing to project.
        break
    }
  }

  /** Derive the harness turn-end reason from the PI turn's terminal message. */
  private turnEndReason(event: Extract<AgentEvent, { type: 'turn_end' }>): TurnEndReason {
    const message = event.message
    if (message.role !== 'assistant') return { kind: 'completed' }
    switch (message.stopReason) {
      case 'error':
        return {
          kind: 'error',
          error: {
            message: message.errorMessage ?? 'pi-ai stream error',
            code: 'PI_AI_ERROR',
          },
        }
      case 'length':
        // The model hit its output-token ceiling; surface the harness
        // max-tokens turn ending.
        return { kind: 'max-tokens' }
      case 'aborted':
        // The loop only aborts when the run signal fired, which the adapter
        // owns through cancel()/disposal; fall back to `user` for a
        // provider-side abort without a recorded harness cause.
        return { kind: 'aborted', reason: this.lastCancelCause ?? { kind: 'user' } }
      default:
        return { kind: 'completed' }
    }
  }

  /** Start one PI loop run: assemble the agent world, then drive the loop. */
  private async kick(): Promise<void> {
    try {
      if (this.phase.kind !== 'running') return
      const { signal } = this.phase.abort
      signal.throwIfAborted()

      const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
      signal.throwIfAborted()
      const sections = renderContextSections(assembly)
      const system = renderPrompt(assembly)
      // TODO(pi-agent): the old loop projected runtime context sections into
      // the step (`RuntimeContextProjection`); the PI loop carries one static
      // system prompt per run, so the projection is deferred.
      const systemPrompt = joinContextSections(sections) || system
      const tools = bridgeTools(this.loopCtx, this, assembly.tools)

      const batch = this.claimWakeBatch()
      if (batch.length === 0) {
        // A wake with nothing to claim still owns its turn boundary per the
        // harness contract; close it immediately.
        const turn = this.phase.turn + 1
        this.phase.turn = turn
        this.session.append('turn/start', { turn })
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        return
      }
      const prompts = this.toPiMessages({ kind: 'enter', messages: batch })
      if (prompts.length === 0) {
        const turn = this.phase.turn + 1
        this.phase.turn = turn
        this.session.append('turn/start', { turn })
        this.session.append('turn/end', { turn, reason: { kind: 'blocked' } })
        return
      }

      const config: AgentLoopConfig = {
        model: createPiModel(this.options.provider ?? '', this.options.model ?? ''),
        convertToLlm: messages => messages.filter(
          (message): message is Extract<AgentMessage, { role: 'user' | 'assistant' | 'toolResult' }> =>
            message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
        ),
        // The harness tool pipeline owns policy and scheduling; the PI loop
        // executes tools sequentially to preserve harness ordering guarantees.
        toolExecution: 'sequential',
        getSteeringMessages: () => this.claimNextStep(),
        getFollowUpMessages: () => this.claimNextTurn(),
      }
      const context = { systemPrompt, messages: this.piMessages.slice(), tools }
      const newMessages = await runAgentLoop(
        prompts,
        context,
        config,
        (event) => { this.projectEvent(event) },
        signal,
        this.streamFn,
      )
      this.piMessages.push(...newMessages)
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }
}
