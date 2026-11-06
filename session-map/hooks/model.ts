// Pure functions over the session map: no `$`, so tests and the sweep share them.
import type {
  EventKind,
  Issue,
  OpenItem,
  SessionMap,
  Source,
} from '../types'

export const EMPTY: SessionMap = { issues: [], events: [], items: [], seq: 0 }

type Applied = { map: SessionMap; message: string; isError?: boolean }

const norm = (s: string) => s.trim().toLowerCase()

/** Finds an issue by id (`I3`) or, failing that, by its exact title. */
export const findIssue = (map: SessionMap, ref: string | undefined) => {
  if (!ref) return undefined
  const r = norm(ref)
  return (
    map.issues.find(i => norm(i.id) === r) ??
    map.issues.find(i => norm(i.title) === r)
  )
}

const event = (
  map: SessionMap,
  at: number,
  issueId: string,
  kind: EventKind,
  text: string,
  source: Source,
): SessionMap => ({
  ...map,
  seq: map.seq + 1,
  events: [
    ...map.events,
    { id: `E${map.seq + 1}`, at, issueId, kind, text, source },
  ].slice(-400),
})

export type TimelineArgs = {
  action: 'open' | 'step' | 'decision' | 'achievement' | 'close'
  issue?: string
  title?: string
  parent?: string
  text?: string
}

export const applyTimeline = (
  map: SessionMap,
  a: TimelineArgs,
  at: number,
  source: Source = 'claude',
): Applied => {
  if (a.action === 'open') {
    const title = (a.title ?? a.text ?? a.issue ?? '').trim()
    if (!title) return { map, message: 'open needs a title', isError: true }
    const existing = findIssue(map, title)
    if (existing) {
      return { map, message: `${existing.id} already exists: ${existing.title}` }
    }
    const parent = findIssue(map, a.parent)
    const id = `I${map.issues.length + 1}`
    const issue: Issue = {
      id,
      title,
      status: 'active',
      openedAt: at,
      ...(parent ? { parentId: parent.id } : {}),
    }
    let next: SessionMap = { ...map, issues: [...map.issues, issue] }
    next = parent
      ? event(next, at, id, 'branched', `Branched off ${parent.id}: ${title}`, source)
      : event(next, at, id, 'opened', title, source)
    return { map: next, message: `opened ${id}` }
  }

  const issue = findIssue(map, a.issue)
  if (!issue) {
    const known = map.issues.map(i => `${i.id} ${i.title}`).join('; ') || 'none'
    return {
      map,
      message: `unknown issue "${a.issue ?? ''}". Known: ${known}. Open it first.`,
      isError: true,
    }
  }

  if (a.action === 'close') {
    if (issue.status === 'closed') return { map, message: `${issue.id} already closed` }
    const issues = map.issues.map(i =>
      i.id === issue.id ? { ...i, status: 'closed' as const, closedAt: at } : i,
    )
    const text = a.text?.trim() || `Closed: ${issue.title}`
    return {
      map: event({ ...map, issues }, at, issue.id, 'closed', text, source),
      message: `closed ${issue.id}`,
    }
  }

  const text = a.text?.trim()
  if (!text) return { map, message: `${a.action} needs text`, isError: true }
  return {
    map: event(map, at, issue.id, a.action, text, source),
    message: `logged ${a.action} on ${issue.id}`,
  }
}

export type ItemArgs = {
  action: 'add' | 'resolve'
  kind?: 'decision' | 'todo'
  text?: string
  options?: string[]
  issue?: string
  id?: string
  outcome?: 'done' | 'dropped'
}

export const applyItem = (
  map: SessionMap,
  a: ItemArgs,
  at: number,
  source: Source = 'claude',
): Applied => {
  if (a.action === 'add') {
    const text = a.text?.trim()
    if (!text) return { map, message: 'add needs text', isError: true }
    const dup = map.items.find(i => i.status === 'open' && norm(i.text) === norm(text))
    if (dup) return { map, message: `already open as ${dup.id}` }
    const kind = a.kind ?? 'todo'
    const count = map.items.filter(i => i.kind === kind).length
    const id = `${kind === 'decision' ? 'D' : 'T'}${count + 1}`
    const issue = findIssue(map, a.issue)
    const options =
      kind === 'decision'
        ? (a.options ?? []).map(o => o.trim()).filter(Boolean).slice(0, 5)
        : undefined
    const item: OpenItem = {
      id,
      kind,
      text,
      status: 'open',
      at,
      source,
      ...(options ? { options: options.length ? options : ['Yes', 'No'] } : {}),
      ...(issue ? { issueId: issue.id } : {}),
    }
    return { map: { ...map, items: [...map.items, item] }, message: `added ${id}` }
  }

  const item = map.items.find(i => norm(i.id) === norm(a.id ?? ''))
  if (!item) return { map, message: `unknown item "${a.id ?? ''}"`, isError: true }
  if (item.status !== 'open') return { map, message: `${item.id} already ${item.status}` }
  return {
    map: resolveItem(map, item.id, a.outcome ?? 'done', at, a.text),
    message: `resolved ${item.id}`,
  }
}

/** Adds an earlier session's open items as new open items here, renumbered. */
export const carryOver = (map: SessionMap, items: OpenItem[], at: number) => {
  let next = map
  for (const it of items) {
    const r = applyItem(next, { action: 'add', kind: it.kind, text: it.text, options: it.options }, at, it.source)
    if (!r.isError && r.map.items.length > next.items.length) {
      const added = r.map.items[r.map.items.length - 1]!
      next = { ...r.map, items: [...r.map.items.slice(0, -1), { ...added, carriedFrom: it.carriedFrom ?? it.at }] }
    }
  }
  return next
}

export const resolveItem = (
  map: SessionMap,
  id: string,
  status: OpenItem['status'],
  at: number,
  answer?: string,
): SessionMap => ({
  ...map,
  items: map.items.map(i =>
    i.id === id
      ? { ...i, status, resolvedAt: at, ...(answer ? { answer } : {}) }
      : i,
  ),
})

/** The nesting depth of an issue: 0 for a root, 1 for a branch off it, … */
export const depthOf = (map: SessionMap, issueId: string) => {
  let depth = 0
  let cur = map.issues.find(i => i.id === issueId)
  const seen = new Set<string>()
  while (cur?.parentId && !seen.has(cur.id) && depth < 6) {
    seen.add(cur.id)
    depth += 1
    cur = map.issues.find(i => i.id === cur!.parentId)
  }
  return depth
}

/** A plain-text digest, what the `session_map` tool answers. */
export const digest = (map: SessionMap) => {
  const active = map.issues.filter(i => i.status === 'active')
  const open = map.items.filter(i => i.status === 'open')
  const lines = [
    `Active issues (${active.length}):`,
    ...active.map(i => `  ${i.id} ${i.title}${i.parentId ? ` (off ${i.parentId})` : ''}`),
    `Closed issues: ${map.issues.filter(i => i.status === 'closed').map(i => i.id).join(', ') || 'none'}`,
    `Open items (${open.length}):`,
    ...open.map(
      i =>
        `  ${i.id} [${i.kind}] ${i.text}${i.options ? ` — options: ${i.options.join(' / ')}` : ''}`,
    ),
    `Recently resolved:`,
    ...map.items
      .filter(i => i.status !== 'open')
      .slice(-8)
      .map(i => `  ${i.id} [${i.status}] ${i.text}${i.answer ? ` → ${i.answer}` : ''}`),
  ]
  return lines.join('\n')
}

// ---- background sweep ------------------------------------------------------

export const sweepPrompt = (map: SessionMap) =>
  [
    'You have no tools. Answer straight away without deliberating.',
    'Audit the session map kept for this conversation (shown below as JSON) against the conversation so far.',
    'Reply with ONLY one JSON object, no prose, with these optional keys:',
    '{"open":[{"title":"...","parent":"I1"}],"events":[{"issue":"I1","kind":"step|decision|achievement","text":"..."}],',
    '"close":["I2"],"items":[{"kind":"decision|todo","text":"...","options":["..."]}],"resolve":["T1"]}',
    'Include ONLY clear omissions: an issue we clearly worked on but is not listed, an issue clearly finished but still active,',
    'a decision the user must still make or unfinished work that is not listed, an open item that is clearly resolved.',
    'Each text one short plain-English line. At most 4 entries per key. If nothing is missing reply {}.',
    '',
    JSON.stringify({
      issues: map.issues.map(({ id, title, status, parentId }) => ({ id, title, status, parentId })),
      recent: map.events.slice(-30).map(({ issueId, kind, text }) => ({ issueId, kind, text })),
      items: map.items.map(({ id, kind, text, status }) => ({ id, kind, text, status })),
    }),
  ].join('\n')

type SweepReply = {
  open?: { title?: string; parent?: string }[]
  events?: { issue?: string; kind?: string; text?: string }[]
  close?: string[]
  items?: { kind?: string; text?: string; options?: string[] }[]
  resolve?: string[]
}

/** Parses the sweep's reply and folds it in; returns the map and a change count. */
export const applySweep = (map: SessionMap, reply: string, at: number) => {
  const match = reply.match(/\{[\s\S]*\}/)
  if (!match) return { map, changes: 0, isParsed: false }
  let parsed: SweepReply
  try {
    parsed = JSON.parse(match[0]) as SweepReply
  } catch {
    return { map, changes: 0, isParsed: false }
  }
  let next = map
  let changes = 0
  const take = (r: Applied) => {
    if (!r.isError && r.map !== next) changes += 1
    next = r.map
  }
  const list = <T,>(v: T[] | undefined) => (Array.isArray(v) ? v.slice(0, 4) : [])

  for (const o of list(parsed.open)) {
    if (typeof o?.title === 'string')
      take(applyTimeline(next, { action: 'open', title: o.title, parent: o.parent }, at, 'auto'))
  }
  for (const ev of list(parsed.events)) {
    const kind = ev?.kind
    if (kind === 'step' || kind === 'decision' || kind === 'achievement')
      take(applyTimeline(next, { action: kind, issue: ev.issue, text: ev.text }, at, 'auto'))
  }
  for (const id of list(parsed.close)) {
    if (typeof id === 'string') take(applyTimeline(next, { action: 'close', issue: id }, at, 'auto'))
  }
  for (const it of list(parsed.items)) {
    const kind = it?.kind === 'decision' ? 'decision' : 'todo'
    if (typeof it?.text === 'string')
      take(applyItem(next, { action: 'add', kind, text: it.text, options: it.options }, at, 'auto'))
  }
  for (const id of list(parsed.resolve)) {
    if (typeof id === 'string') take(applyItem(next, { action: 'resolve', id }, at, 'auto'))
  }
  return { map: next, changes, isParsed: true }
}

export const timeOf = (ms: number) => {
  try {
    return new Date(ms).toLocaleTimeString('en-CA', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** Tools that are not work in themselves: using only these never earns a nudge. */
export const NOT_WORK = new Set(['ToolSearch', 'AskUserQuestion', 'TodoWrite'])

/** After this many working turns in a row with nothing logged, nudge even mid-issue. */
export const NUDGE_AFTER_TURNS = 3

/**
 * Whether the next prompt should carry a reminder to log. `unloggedTurns` counts
 * the turns in a row where Claude used tools but never touched the session map.
 * With no active issue, one such turn is enough: work is happening off the map.
 * With one active, logging every turn would be noise, so wait a few.
 */
export const shouldNudge = (map: SessionMap, unloggedTurns: number) => {
  if (unloggedTurns < 1) return false
  const hasActive = map.issues.some(i => i.status === 'active')
  return !hasActive || unloggedTurns >= NUDGE_AFTER_TURNS
}

export const nudgeText = (map: SessionMap) =>
  map.issues.some(i => i.status === 'active')
    ? 'Session map reminder: the last few turns used tools but logged nothing to the timeline. If that work reached a key moment (a step, a decision, an achievement) or finished an issue, log it now with mcp__session-map__timeline before answering. If it started a different problem, open a new issue for it.'
    : 'Session map reminder: the last turn used tools but no issue is open on the timeline, so that work is missing from it. Before answering, call mcp__session-map__timeline with action "open" for the work under way (and close it if it is already finished).'

/** The message sent after carried items arrive: check them before trusting them. */
export const carriedCheckPrompt = (items: OpenItem[]) =>
  [
    `I brought in ${items.length} open item(s) from the last session in this folder. They were copied as they were, so some may already be done or out of date:`,
    ...items.map(i => `- ${i.id} [${i.kind}] ${i.text}`),
    'Check each one against the actual state of the work (git log, git status, the files involved). Resolve the ones already done (outcome "done") or no longer relevant ("dropped") with mcp__session-map__open_items, and merge duplicates. Then tell me in a few lines which are still open and why.',
  ].join('\n')

/** The message a to-do's Start button sends: begin the work, and be honest about the person's part. */
export const startPrompt = (item: OpenItem) =>
  `Start ${item.id}: "${item.text}". Check its current state first, then do the parts you can. If some of it can only be done by me (a restart, a login, a click in a console), prepare what you can and tell me exactly what is left for me. Resolve ${item.id} with mcp__session-map__open_items only once it is actually done.`
