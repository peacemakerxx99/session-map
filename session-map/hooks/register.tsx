import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

type PaneInput = Extract<RenderInput, { component: 'Pane' }>

import type { CarryOffer, OpenItem, SessionMap } from '../types'
import {
  EMPTY,
  applyItem,
  applySweep,
  applyTimeline,
  NOT_WORK,
  carriedCheckPrompt,
  startPrompt,
  carryOver,
  depthOf,
  digest,
  nudgeText,
  shouldNudge,
  resolveItem,
  sweepPrompt,
  timeOf,
} from './model'
import type { ItemArgs, TimelineArgs } from './model'

const COMBINED = 'session-map'
// Panes earlier versions opened beside the map; closed at start so only the
// map shows and the engine draws no tab row.
const RETIRED = ['timeline', 'open-items', 'session-map-completed']
const WELCOME = 'session-map-welcome'
// The top section's name: it holds decisions and unfinished work.
const ITEMS_TITLE = 'Decisions & to-dos'
// The timed catch-up check: every 15 minutes, only when turns ran since the last one.
const AUTO_CHECK_MS = 15 * 60 * 1000
// Bump to show the welcome again to everyone after its text changes.
const WELCOME_VERSION = 'welcome-2'
const SWEEP_EVERY_TURNS = 10
const KEEP_SESSIONS = 40
// Theme keys, not fixed colours: they follow the person's light/dark/daltonized theme.
const PALETTE = ['suggestion', 'success', 'claude', 'merged', 'planMode', 'permission']
const GLYPH: Record<string, string> = {
  opened: '●',
  branched: '↳',
  step: '·',
  decision: '◆',
  achievement: '★',
  closed: '✓',
}

// Change the tag when SessionMap's fields change: older stored values are declined.
const mapAtom = atom({ plugin: 'session-map', key: 'map' } as const, EMPTY, {
  shape: 'map-1',
})
const carry = atom({ plugin: 'session-map', key: 'carry' } as const, null as CarryOffer | null)
const panes = atom({ plugin: 'session-map', key: 'panes' } as const, {
  timeline: false,
  items: false,
  combined: false,
  completed: false,
})

const TOOL_TIMELINE = 'mcp__session-map__timeline'
const TOOL_ITEMS = 'mcp__session-map__open_items'
const TOOL_READ = 'mcp__session-map__session_map'

const GUIDANCE = `## Session map (mod)
The user keeps a live timeline and an open-items list of this session in side panes, and watches them while you work. Keep them current:
- Before your first other tool call on any new request, call ${TOOL_TIMELINE} with action "open" for it (title = short plain-English name; parent = the issue id it branched off from, if any). Do this for small tasks too, unless the request continues an issue that is already open. Answering a question with no tools needs no issue.
- Log only key moments on that issue: a notable step, a decision taken, an achievement ("step" / "decision" / "achievement"). One short line each; skip trivia.
- When an issue is finished, call it with action "close".
- When something needs the user's decision, call ${TOOL_ITEMS} with action "add", kind "decision", and 2-4 short options they can click. Unfinished work that must not be forgotten: kind "todo". Resolve items when they are done.
- When the user answers an open decision in the chat instead of clicking its button, resolve it at once with ${TOOL_ITEMS} (action "resolve", text = the answer), and resolve any to-do the chat shows is done or dropped.
- The user's button clicks arrive as messages from the session-map plugin; act on them.
- Before "close session" or any wrap-up, call ${TOOL_READ} and surface everything still open.`

const WHY =
  "Long Claude Code sessions drift. We start on one issue, run into another problem on the way, fix that, then another — and by the end I'd lost track of what happened and what was still open. I was always afraid of closing a session and forgetting something. So I built a map of the session that sits beside the chat."

const JUST_INSTALLED =
  'Just installed? Start a new session. This one has the panes but not the instructions that tell Claude to log, so its timeline may stay empty.'

const WHAT = [
  '• Decisions & to-dos, on top: decisions waiting on you, each with buttons. Click an option and Claude receives your answer as a message — no typing. Unfinished work has Start (Claude begins it), Done and Drop buttons. Refresh checks the conversation for anything already settled.',
  '• Timeline, below: the active issues, then every moment of the session, newest at the top. A side quest is indented under the issue it branched off from; finished issues fade to grey.',
  '• Completed, at the bottom: each finished issue with its whole story.',
  '• The pane scrolls: ctrl+x gives it the keyboard, then ↑↓ or the mouse wheel.',
]

const HOW = [
  '• Claude logs the key moments itself (an issue starts, a decision, an achievement, an issue closes) with three tools this mod adds, guided by a short instruction added to its system prompt.',
  '• A quick background check rereads the conversation and adds anything Claude missed (marked ⟲): every 10 turns, every 15 minutes while the chat is moving, and when you press Refresh. It runs on your own Claude session, so it uses a little of your usage.',
  '• Before wrapping up a session, Claude reads the list, so nothing open is left behind.',
  "• Each session's map is saved on this computer only; resuming a session brings it back.",
]

const COMMANDS = [
  '/session-map — show or hide the pane',
  '/session-map-check — run the catch-up check now',
  '/session-map-about — this page again',
]

const colorOf = (map: SessionMap, issueId: string) => {
  const idx = map.issues.findIndex(i => i.id === issueId)
  return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length]
}

let sid = ''
let turns = 0
let turnsAtLastSweep = 0
let isSweeping = false
let cwd = ''
// Nudge bookkeeping for the main loop: did this turn work, did it log, and how
// many working turns in a row logged nothing. A reload starts these over.
let isWorking = false
let isLogged = false
let unloggedTurns = 0
let pendingNudge = ''

// Every write goes through here: the session's state, then the store, so
// a --resume brings the map back.
async function mutate($: EngineInterface, fn: (m: SessionMap) => SessionMap) {
  const next = await update($, mapAtom, m => fn(m ?? EMPTY))
  if (sid) await $.store.set(`map:${sid}`, next ?? (await read($, mapAtom)))
  // The latest session in this folder with something on its map: what the
  // next session here offers to carry over.
  if (sid && cwd) await $.store.set(`last:${cwd}`, sid)
}

async function sweep($: EngineInterface): Promise<string> {
  if (isSweeping) return 'a check is already running'
  isSweeping = true
  turnsAtLastSweep = turns
  try {
    const map = await read($, mapAtom)
    const reply = await $.model.fork({ prompt: sweepPrompt(map) })
    if (!reply.isAnswered) return `check got no answer (${reply.reason})`
    const now = await $.clock.now()
    let changes = 0
    let isParsed = false
    await mutate($, m => {
      const r = applySweep(m, reply.text, now)
      changes = r.changes
      isParsed = r.isParsed
      return r.map
    })
    if (!isParsed) return 'check answered but not in the expected format'
    if (changes > 0) $.ui.toast(`Session map: ${changes} item(s) caught up`)
    return `check done, ${changes} change(s)`
  } finally {
    isSweeping = false
  }
}

// The Refresh button: the check outlasts a press's 10 s budget, so it is fired,
// not awaited, and says how it went in a toast.
function refresh($: EngineInterface) {
  $.ui.toast('Session map: checking the conversation…')
  void sweep($)
    .then(msg => $.ui.toast(`Session map: ${msg}`))
    .catch(() => $.ui.toast('Session map: the check failed'))
}

// The timed check: skipped while nothing happened since the last one.
function autoCheck($: EngineInterface) {
  if (turns > turnsAtLastSweep) void sweep($).catch(() => {})
}

const MAP_PANE = { id: COMBINED, title: 'Session map' } as const

async function toggle($: EngineInterface): Promise<string> {
  const flags = await read($, panes)
  const isOpen = !flags.combined
  if (isOpen) await $.ui.open(MAP_PANE)
  else await $.ui.close({ id: COMBINED })
  await update($, panes, f => ({ ...(f ?? flags), combined: isOpen }))
  return isOpen ? 'shown' : 'hidden'
}

// The one pane, for everyone: with a single pane open the engine draws no tabs.
async function openDefaultTabs($: EngineInterface) {
  for (const id of RETIRED) await $.ui.close({ id }).catch(() => {})
  const r = await $.ui.open(MAP_PANE)
  if (r?.isPlaced) await update($, panes, f => ({ ...f, combined: true }))
}

async function acceptCarry($: EngineInterface) {
  const offer = await read($, carry)
  if (!offer) return
  const now = await $.clock.now()
  await mutate($, m => carryOver(m, offer.items, now))
  await update($, carry, () => null)
  await $.store.set(`carry-asked:${sid}`, true)
  // The items were copied as they were: ask Claude to check them against the
  // work itself. Fired, not awaited (a button's press budget is 10 s).
  const map = await read($, mapAtom)
  const carried = map.items.filter(i => i.status === 'open' && i.carriedFrom !== undefined)
  if (carried.length > 0) void $.prompt.submit({ text: carriedCheckPrompt(carried) })
}

async function declineCarry($: EngineInterface) {
  await update($, carry, () => null)
  await $.store.set(`carry-asked:${sid}`, true)
}

// A new session in a folder whose last session left items open: offer them.
async function offerCarry($: EngineInterface) {
  const now = await read($, mapAtom)
  if (now.issues.length > 0 || now.items.length > 0) return
  if (await $.store.get(`carry-asked:${sid}`)) return
  const prevSid = (await $.store.get(`last:${cwd}`)) as string | undefined
  if (!prevSid || prevSid === sid) return
  const prev = (await $.store.get(`map:${prevSid}`)) as SessionMap | undefined
  const open = (prev?.items ?? []).filter(i => i.status === 'open')
  await update($, carry, () => (open.length > 0 ? { fromSid: prevSid, items: open } : null))
}

async function dismissWelcome($: EngineInterface) {
  await $.store.set('welcomed', WELCOME_VERSION)
  await $.ui.close({ id: WELCOME })
  await openDefaultTabs($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sid = await $.session.id()
    cwd = e.cwd ?? ''
    const current = await read($, mapAtom)
    if (current.issues.length === 0 && current.items.length === 0) {
      const saved = (await $.store.get(`map:${sid}`)) as SessionMap | undefined
      if (saved && Array.isArray(saved.issues) && Array.isArray(saved.items)) {
        await update($, mapAtom, () => ({ ...EMPTY, ...saved }))
      }
    }
    const index = ((await $.store.get('sessions')) as string[] | undefined) ?? []
    const kept = [...index.filter(s => s !== sid), sid]
    for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_SESSIONS))) {
      await $.store.delete(`map:${old}`)
      await $.store.delete(`carry-asked:${old}`)
    }
    await $.store.set('sessions', kept.slice(-KEEP_SESSIONS))

    if (cwd) await offerCarry($)

    await $.command.register({ name: 'session-map', description: 'Show or hide the combined pane: open items on top, timeline below' })
    $.clock.every(AUTO_CHECK_MS, () => autoCheck($))
    await $.command.register({ name: 'session-map-check', description: 'Ask Claude now to catch the session map up on anything missed' })

    await $.tool.register({
      name: 'timeline',
      isDeferred: false,
      description:
        "Record a key moment in this session's timeline pane: open an issue (optionally branched off a parent), log a notable step/decision/achievement on it, or close it. Use it throughout the session without being asked: open an issue when work on a distinct problem starts, log each notable step, decision or achievement in one short line, and close the issue when it is finished. Skip trivia.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'step', 'decision', 'achievement', 'close'] },
          issue: { type: 'string', description: 'Issue id (e.g. I2) or exact title; not needed for open' },
          title: { type: 'string', description: 'For open: short plain-English name of the issue' },
          parent: { type: 'string', description: 'For open: id of the issue this branched off from' },
          text: { type: 'string', description: 'One short line describing the moment' },
        },
        required: ['action'],
      },
    })
    await $.tool.register({
      name: 'open_items',
      isDeferred: false,
      description:
        "Add or resolve an item in the open-items pane. kind 'decision' shows the user clickable option buttons (give 2-4 short options); kind 'todo' is unfinished work. Use it without being asked whenever something needs the user's decision or work is left unfinished, and resolve items when they are done. The user's button clicks arrive as messages from the session-map plugin; act on them.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'resolve'] },
          kind: { type: 'string', enum: ['decision', 'todo'] },
          text: { type: 'string', description: 'For add: the question or the work left' },
          options: { type: 'array', items: { type: 'string' }, description: 'For decisions: 2-4 short button labels' },
          issue: { type: 'string', description: 'Optional issue id it belongs to' },
          id: { type: 'string', description: 'For resolve: item id (D1, T2)' },
          outcome: { type: 'string', enum: ['done', 'dropped'] },
        },
        required: ['action'],
      },
    })
    await $.tool.register({
      name: 'session_map',
      isDeferred: false,
      description: 'Read the session map: active and closed issues and every open item. Call it before closing or wrapping up a session, and surface everything still open.',
      inputSchema: { type: 'object', properties: {} },
    })

    await $.command.register({ name: 'session-map-about', description: 'Why this mod exists, what it does and how it works' })

    const isNewHere = (await $.store.get('welcomed')) !== WELCOME_VERSION
    if (e.isInteractive !== false && isNewHere) {
      void $.ui.open({ id: WELCOME, title: 'Welcome to session-map' })
    } else if (e.isInteractive !== false) {
      void openDefaultTabs($)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return {
      sections: [...r.sections, { id: 'session-map:guidance', text: GUIDANCE, scope: 'session' as const }],
    }
  })

  // Watches every other tool the main loop runs, to tell working turns apart.
  // Observe only: it always passes the call on.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId && !e.tool.startsWith('mcp__session-map__') && !NOT_WORK.has(e.tool)) isWorking = true
    return next(e)
  })

  // A reminder the turn after unlogged work, riding beside the next prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!pendingNudge) return next(e)
    const text = pendingNudge
    pendingNudge = ''
    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  on('tool.call', { tool: TOOL_TIMELINE }, async ($, e) => {
    if (!e.agentId) isLogged = true
    const now = await $.clock.now()
    let out: { message: string; isError?: boolean } = { message: '' }
    await mutate($, m => {
      const r = applyTimeline(m, e as unknown as TimelineArgs, now)
      out = r
      return r.map
    })
    return out.isError ? { deny: out.message } : { result: out.message }
  })

  on('tool.call', { tool: TOOL_ITEMS }, async ($, e) => {
    if (!e.agentId) isLogged = true
    const now = await $.clock.now()
    let out: { message: string; isError?: boolean } = { message: '' }
    await mutate($, m => {
      const r = applyItem(m, e as unknown as ItemArgs, now)
      out = r
      return r.map
    })
    return out.isError ? { deny: out.message } : { result: out.message }
  })

  on('tool.call', { tool: TOOL_READ }, async $ => ({ result: digest(await read($, mapAtom)) }))

  on('command.run', { command: 'session-map-about' }, async $ => {
    await $.ui.open({ id: WELCOME, title: 'About session-map' })
    return { text: 'About session-map opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: WELCOME }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const head = (title: string, color: string, key: string) => (
      <Box borderStyle="round" borderColor={color} paddingX={1} marginTop={1} key={key}>
        <Text bold color={color}>{title}</Text>
      </Box>
    )
    const line = (t: string) => <Text color="text">{t}</Text>
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="warning" paddingX={1} key="w-new">
          <Text bold color="warning">{JUST_INSTALLED}</Text>
        </Box>
        {head('WHY I MADE THIS', 'claude', 'w-why')}
        {line(WHY)}
        {head('WHAT IT DOES', 'warning', 'w-what')}
        {WHAT.map(line)}
        {head('HOW IT WORKS', 'suggestion', 'w-how')}
        {HOW.map(line)}
        {head('COMMANDS', 'success', 'w-cmd')}
        {COMMANDS.map(line)}
        <Box marginTop={1}>
          <Button key="welcome-ok" variant="primary" onPress={() => dismissWelcome($)}>
            Got it — show my session map
          </Button>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'session-map' }, async $ => ({ text: `Session map ${await toggle($)}.` }))
  on('command.run', { command: 'session-map-check' }, async $ => ({ text: `Session map: ${await sweep($)}.` }))

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      if (isLogged) unloggedTurns = 0
      else if (isWorking) unloggedTurns += 1
      const map = await read($, mapAtom)
      // Only right after a turn that worked without logging: a chat turn stays quiet.
      pendingNudge = isWorking && !isLogged && shouldNudge(map, unloggedTurns) ? nudgeText(map) : ''
      isWorking = false
      isLogged = false
    }
    if (!e.agentId && !e.isAborted) {
      turns += 1
      if (turns % SWEEP_EVERY_TURNS === 0) {
        $.clock.after(1000, () => {
          void sweep($).catch(() => {})
        })
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: COMBINED }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const items = await itemsBody($, e as PaneInput)
    const timeline = await timelineBody($, e as PaneInput)
    const completed = await completedBody($, e as PaneInput)
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="warning" paddingX={1} key="hdr-items">
          <Text bold color="warning">{ITEMS_TITLE.toUpperCase()}</Text>
        </Box>
        {items}
        <Box borderStyle="round" borderColor="suggestion" paddingX={1} marginTop={1} key="hdr-timeline">
          <Text bold color="suggestion">TIMELINE</Text>
        </Box>
        {timeline}
        <Box borderStyle="round" borderColor="success" paddingX={1} marginTop={1} key="hdr-completed">
          <Text bold color="success">COMPLETED</Text>
        </Box>
        {completed}
      </Box>
    )
  })
}

// ---- Timeline pane --------------------------------------------------------
async function timelineBody($: EngineInterface, e: PaneInput) {
  const { Box, Text } = $.ui.resolve(e)
  const map = await read($, mapAtom)
  const width = Math.max(20, e.props.bodyColumns ?? 40)
  const active = map.issues.filter(i => i.status === 'active')
  const done = map.issues.filter(i => i.status === 'closed')
  const byId = new Map(map.issues.map(i => [i.id, i]))
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

  if (map.issues.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No issues logged yet.</Text>
        <Text dimColor>Claude adds them as work starts.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color="text">Active ({active.length})</Text>
      {active.map(i => (
        <Text color={colorOf(map, i.id)}>
          {'  '.repeat(depthOf(map, i.id))}● {i.id} {cut(i.title, width - 6 - 2 * depthOf(map, i.id))}
        </Text>
      ))}
      {done.length > 0 && (
        <Text color="inactive">Completed ({done.length}): {done.map(i => i.id).join(', ')} — full story under Completed, below</Text>
      )}
      <Text color="text">
        Legend: <Text color={PALETTE[0]}>colour</Text> = active · <Text color="inactive">grey</Text> = completed · ⟲ = added by the catch-up check · ↩ = carried from last session
      </Text>
      <Text dimColor>{'─'.repeat(Math.min(width, 40))}</Text>
      {/* Newest first: the latest moment sits under the header, history below. */}
      {[...map.events].reverse().map(ev => {
        const issue = byId.get(ev.issueId)
        const isClosed = issue?.status === 'closed'
        const indent = '  '.repeat(depthOf(map, ev.issueId))
        const head = `${timeOf(ev.at)} ${indent}${GLYPH[ev.kind] ?? '·'} ${ev.issueId} `
        const isHeader = ev.kind === 'opened' || ev.kind === 'branched' || ev.kind === 'closed'
        return (
          <Text
            color={isClosed ? 'inactive' : colorOf(map, ev.issueId)}
            dimColor={isClosed}
            bold={isHeader && !isClosed}
          >
            {head}
            {cut(ev.text, width - head.length)}
            {ev.source === 'auto' ? ' ⟲' : ''}
          </Text>
        )
      })}
    </Box>
  )
}

// ---- Completed pane -------------------------------------------------------
// Each finished issue, latest finished first, with its moments in order.
async function completedBody($: EngineInterface, e: PaneInput) {
  const { Box, Text } = $.ui.resolve(e)
  const map = await read($, mapAtom)
  const width = Math.max(20, e.props.bodyColumns ?? 40)
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
  const done = map.issues
    .filter(i => i.status === 'closed')
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))

  if (done.length === 0) return <Text dimColor>No completed issues yet.</Text>

  return (
    <Box flexDirection="column">
      {done.map(i => (
        <Box flexDirection="column" marginTop={1} key={`done-${i.id}`}>
          <Text bold color="success">
            ✓ {i.id} {i.title}
            {i.parentId ? ` (off ${i.parentId})` : ''}
          </Text>
          {map.events
            .filter(ev => ev.issueId === i.id && ev.kind !== 'opened' && ev.kind !== 'branched')
            .map(ev => {
              const head = `  ${timeOf(ev.at)} ${GLYPH[ev.kind] ?? '·'} `
              return (
                <Text color="text">
                  {head}
                  {cut(ev.text, width - head.length)}
                  {ev.source === 'auto' ? ' ⟲' : ''}
                </Text>
              )
            })}
        </Box>
      ))}
    </Box>
  )
}

// ---- Open items pane ------------------------------------------------------
async function itemsBody($: EngineInterface, e: PaneInput) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const map = await read($, mapAtom)
  const open = map.items.filter(i => i.status === 'open')
  const offer = await read($, carry)
  const decisions = open.filter(i => i.kind === 'decision')
  const todos = open.filter(i => i.kind === 'todo')
  const recent = map.items
    .filter(i => i.status !== 'open')
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, 5)

  const answer = async (item: OpenItem, option: string) => {
    const now = await $.clock.now()
    await mutate($, m => {
      let n = resolveItem(m, item.id, 'answered', now, option)
      if (item.issueId) {
        n = applyTimeline(n, { action: 'decision', issue: item.issueId, text: `You chose "${option}": ${item.text}` }, now, 'person').map
      }
      return n
    })
    // Not awaited: mid-turn the submit resolves only when the next turn starts,
    // which can outlast the press hook's 10s budget. Queued now either way.
    void $.prompt.submit({ text: `Decision ${item.id} — "${item.text}" → the user chose: ${option}` })
  }
  const finish = async (item: OpenItem, status: 'done' | 'dropped') => {
    const now = await $.clock.now()
    await mutate($, m => resolveItem(m, item.id, status, now))
  }
  const discuss = (item: OpenItem) =>
    void $.prompt.submit({ text: `Let's discuss ${item.id} before I decide: "${item.text}"` })
  // Not awaited, for the same reason as answer(). The item stays open: Claude
  // resolves it once the work is actually done.
  const start = (item: OpenItem) =>
    void $.prompt.submit({ text: startPrompt(item) })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" key="refresh-row">
        <Button key="refresh" onPress={() => refresh($)}>
          <Text color="text">⟳ Refresh</Text>
        </Button>
        <Text dimColor> ctrl+x, then ↑↓ to scroll</Text>
      </Box>
      {offer && (
        <Box flexDirection="column" marginBottom={1} key="carry">
          <Text bold color="claude">
            ↩ Your last session in this folder left {offer.items.length} open item{offer.items.length === 1 ? '' : 's'}:
          </Text>
          {offer.items.slice(0, 6).map(it => (
            <Text color="text">
              {'  '}{it.kind === 'decision' ? '◆' : '□'} {it.text}
            </Text>
          ))}
          {offer.items.length > 6 && <Text dimColor>  …and {offer.items.length - 6} more</Text>}
          <Box flexDirection="row">
            <Button key="carry-yes" variant="primary" onPress={() => acceptCarry($)}>
              Bring them in
            </Button>
            <Button key="carry-no" onPress={() => declineCarry($)}>
              <Text color="text">No thanks</Text>
            </Button>
          </Box>
        </Box>
      )}
      {open.length === 0 && !offer && <Text dimColor>Nothing open.</Text>}
      {decisions.length > 0 && <Text bold color="warning">Decisions for you ({decisions.length})</Text>}
      {decisions.map(item => (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="text">
            ◆ {item.id} {item.text}
            {item.carriedFrom ? ' ↩' : ''}
            {item.source === 'auto' ? ' ⟲' : ''}
          </Text>
          <Box flexDirection="row" flexWrap="wrap">
            {(item.options ?? ['Yes', 'No']).map((opt, n) => (
              <Button key={`${item.id}-o${n}`} variant={n === 0 ? 'primary' : undefined} onPress={() => answer(item, opt)}>
                <Text color={n === 0 ? undefined : 'text'}>{opt}</Text>
              </Button>
            ))}
            <Button key={`${item.id}-talk`} onPress={() => discuss(item)}>
              <Text color="text">Discuss</Text>
            </Button>
          </Box>
        </Box>
      ))}
      {todos.length > 0 && <Text bold color="suggestion">Unfinished ({todos.length})</Text>}
      {todos.map(item => (
        <Box flexDirection="row" flexWrap="wrap">
          <Text color="text">
            □ {item.id} {item.text}
            {item.carriedFrom ? ' ↩' : ''}
            {item.source === 'auto' ? ' ⟲' : ''}{' '}
          </Text>
          <Button key={`${item.id}-start`} variant="primary" onPress={() => start(item)}>
            Start
          </Button>
          <Button key={`${item.id}-done`} onPress={() => finish(item, 'done')}>
            <Text color="text">Done</Text>
          </Button>
          <Button key={`${item.id}-drop`} role="dismiss" onPress={() => finish(item, 'dropped')}>
            <Text color="text">Drop</Text>
          </Button>
        </Box>
      ))}
      {recent.length > 0 && <Text dimColor>── Recently resolved</Text>}
      {recent.map(item => (
        <Text dimColor>
          ✓ {item.id} {item.text}
          {item.answer ? ` → ${item.answer}` : ` (${item.status})`}
        </Text>
      ))}
    </Box>
  )
}
