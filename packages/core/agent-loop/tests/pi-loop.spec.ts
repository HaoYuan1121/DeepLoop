/**
 * Loop-behavior specs for the PI-driven agent loop (deepseek-pi).
 *
 * These replace the upstream `ReactLoopAgent` specs, whose turn/step
 * accounting, scheduler tool-order, request-error recovery, and cancellation
 * semantics are intentionally different in the PI loop. See the package
 * README's Known Limitations for the exact differences.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function steer(agent: Agent, text: string): void {
  agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** All user-message texts recorded in the log (to assert what actually ran). */
function userTexts(agent: Agent): string[] {
  return agent.session.events
    .filter((event): event is Extract<typeof event, { type: 'user/message' }> => event.type === 'user/message')
    .flatMap(event => event.data.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** Event types in log order, excluding durable inbox-splice bookkeeping. */
function eventTypes(agent: Agent): string[] {
  return agent.session.events
    .map(event => event.type)
    .filter(type => type !== 'agent/inbox/spliced')
}

describe('pi agent loop', () => {
  it('runs one completed turn and logs the durable turn/step shape', async () => {
    const adapter = new MockAdapter([textResponse('hello there')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'hi')
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(eventTypes(agent)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'request/header',
      'request/context',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason : undefined).toEqual({ kind: 'completed' })
    expect(agent.session.deriveMessages()).toHaveLength(2)
    expect(userTexts(agent)).toEqual(['hi'])
    expect(adapter.requests[0]?.messages.map(m => m.content[0])).toMatchObject([
      { type: 'text', text: 'hi' },
    ])
  })

  it('round-trips tool calls through the harness pipeline', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling echo'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'use the tool')
    await idle

    // two model calls happened (tool-call turn, then final turn)
    expect(adapter.requests).toHaveLength(2)

    // the second request's derived history contains the tool result
    const secondMessages = adapter.requests[1]!.messages
    const toolResultMessage = secondMessages.find(message =>
      message.content.some(block => block.type === 'tool-result'))
    expect(toolResultMessage).toBeDefined()
    const block = toolResultMessage!.content.find(block => block.type === 'tool-result')!
    expect(block).toMatchObject({ toolCallId: 'c1', isError: false })
    expect(block.content).toEqual([{ type: 'text', text: 'echo: ping' }])

    // session log records call + result inside one step of the second turn
    const types = eventTypes(agent)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    const turns = agent.session.events.filter(event => event.type === 'turn/start')
    expect(turns).toHaveLength(2)
    expect(agent.session.deriveMessages()).toHaveLength(4)
  })

  it('records a max-tokens finish as the turn end reason', async () => {
    const adapter = new MockAdapter([maxTokensResponse('cut off')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'go')
    await idle

    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason : undefined)
      .toMatchObject({ kind: 'max-tokens' })
  })

  it('steer on an idle agent starts a turn; followup queues the next', async () => {
    const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a4'), { provider: 'mock', model: 'mock' })

    const firstIdle = waitForIdle(ctx, agent)
    steer(agent, 'steer me')
    await firstIdle
    expect(adapter.requests).toHaveLength(1)
    expect(userTexts(agent)).toEqual(['steer me'])

    const secondIdle = waitForIdle(ctx, agent)
    send(agent, 'follow up')
    await secondIdle
    expect(adapter.requests).toHaveLength(2)
    expect(userTexts(agent)).toEqual(['steer me', 'follow up'])
  })

  it('cancel aborts a hanging turn with the recorded cause', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a5'), { provider: 'mock', model: 'mock' })

    const running = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'running') { dispose(); resolve() }
      })
    })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'hang forever')
    await running
    // Wait until the model request is genuinely in flight before cancelling.
    while (adapter.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    agent.cancel({ kind: 'user' })
    await idle
    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason : undefined)
      .toMatchObject({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('delivers injected context to the next run without opening a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a6'), { provider: 'mock', model: 'mock' })

    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    // Idle injection is staged in the inbox; no turn opens.
    expect(eventTypes(agent)).toEqual([])
    const idle = waitForIdle(ctx, agent)
    send(agent, 'now run')
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(userTexts(agent)).toEqual(['context', 'now run'])
  })
})

