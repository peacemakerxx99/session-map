import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, applySweep, applyTimeline } from './model'

const pane = (requestId: string) =>
  ({
    plugin: 'session-map',
    component: 'Pane',
    requestId,
    props: {
      title: requestId,
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const engine = (
  on: any,
  submitted: string[],
  opened: string[] = [],
  stored: Record<string, unknown> = {},
  contexts: (readonly string[] | undefined)[] = [],
) => {
  const clock = mock.clock(on, { now: 1_762_430_400_000 })
  mock.store(on, stored)
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: {} }))
  on('ui.open', (_: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    contexts.push(e.context)
    return { text: e.text }
  })
  return clock
}

const start = ($: any, cwd = '/') =>
  $.session.start({ cwd, surface: 'terminal', isInteractive: true })

test('issues, branches and closes show in the timeline; closed ones dim', async ($, on) => {
  engine(on, [])
  await start($)
  const T = 'mcp__session-map__timeline'
  await $.tool.call({ tool: T, action: 'open', title: 'Fix login bug' } as any)
  await $.tool.call({ tool: T, action: 'step', issue: 'I1', text: 'Read the auth code' } as any)
  await $.tool.call({ tool: T, action: 'open', title: 'Token expiry wrong', parent: 'I1' } as any)
  await $.tool.call({ tool: T, action: 'close', issue: 'I1' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('timeline'), surface })
    const branch = await ui.find({ type: 'Text', text: /Branched off I1/ })
    expect(branch).toBeDefined()
    const step = await ui.find({ type: 'Text', text: /Read the auth code/ })
    expect(step?.props?.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Completed \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ I1 Fix login bug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /grey.*= completed/ })).toBeDefined()
    const active = await ui.find({ type: 'Text', text: /● I2 Token expiry wrong/ })
    expect(active?.props?.dimColor).not.toBe(true)
    await ui.unmount()
  }
})

test('an unknown issue is refused with the list of known ones', async ($, on) => {
  engine(on, [])
  await start($)
  const r: any = await $.tool.call({ tool: 'mcp__session-map__timeline', action: 'step', issue: 'I9', text: 'x' } as any)
  expect(String(r.deny ?? r.text)).toMatch(/unknown issue/)
})

test('Start on a to-do asks Claude to begin it and leaves the item open', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await $.tool.call({ tool: 'mcp__session-map__open_items', action: 'add', kind: 'todo', text: 'Write README' } as any)

  const ui = await $.ui.mount({ ...pane('open-items'), surface: 'terminal' })
  await ui.press({ key: 'T1-start' })
  expect(submitted.at(-1)).toMatch(/Start T1: "Write README"/)
  expect(submitted.at(-1)).toMatch(/left for me/)
  expect(await ui.find({ type: 'Text', text: /□ T1 Write README/ })).toBeDefined()
})

test('clicking a decision option sends it to Claude and resolves the item', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await $.tool.call({
    tool: 'mcp__session-map__open_items',
    action: 'add',
    kind: 'decision',
    text: 'One repo or two?',
    options: ['One repo', 'Two repos'],
  } as any)
  await $.tool.call({ tool: 'mcp__session-map__open_items', action: 'add', kind: 'todo', text: 'Write README' } as any)

  const ui = await $.ui.mount({ ...pane('open-items'), surface: 'terminal' })
  await ui.press({ key: 'D1-o1' })
  expect(submitted.at(-1)).toMatch(/D1 .*One repo or two\?.*Two repos/)
  expect(await ui.find({ type: 'Text', text: /✓ D1 .*→ Two repos/ })).toBeDefined()

  await ui.press({ key: 'T1-done' })
  expect(await ui.find({ type: 'Text', text: /Nothing open/ })).toBeDefined()
  await ui.unmount()

  const digest: any = await $.tool.call({ tool: 'mcp__session-map__session_map' } as any)
  expect(JSON.stringify(digest)).toMatch(/Open items \(0\)/)
})

test('the background check folds in what it found and ignores junk', async () => {
  const base = applyTimeline(EMPTY, { action: 'open', title: 'A' }, 1).map
  const r = applySweep(
    base,
    'Sure: {"close":["I1"],"items":[{"kind":"decision","text":"Ship it?","options":["Yes","No"]}]}',
    2,
  )
  expect(r.isParsed).toBe(true)
  expect(r.changes).toBe(2)
  expect(r.map.issues[0]?.status).toBe('closed')
  expect(r.map.items[0]?.source).toBe('auto')
  expect(applySweep(base, 'no json here', 3).isParsed).toBe(false)
  expect(applySweep(base, '{}', 3).changes).toBe(0)
})

test('the combined pane shows open items above the timeline', async ($, on) => {
  engine(on, [])
  await start($)
  await $.tool.call({ tool: 'mcp__session-map__timeline', action: 'open', title: 'Repo setup' } as any)
  await $.tool.call({
    tool: 'mcp__session-map__open_items',
    action: 'add',
    kind: 'decision',
    text: 'Public or private?',
    options: ['Private', 'Public'],
  } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('session-map'), surface })
    expect(await ui.find({ type: 'Text', text: /D1 Public or private\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^OPEN ITEMS & DECISIONS$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^TIMELINE$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /I1 Repo setup/ })).toBeDefined()
    expect(await ui.find({ key: 'D1-o0' })).toBeDefined()
    await ui.unmount()
  }
})

test('first run shows the welcome once; Got it switches to the map', async ($, on) => {
  const opened: string[] = []
  const clock = engine(on, [], opened)
  await start($)
  expect(opened).toContain('session-map-welcome')
  expect(opened).not.toContain('session-map')

  const ui = await $.ui.mount({ ...pane('session-map-welcome'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^WHY I MADE THIS$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /afraid of closing a session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Just installed\? Start a new session/ })).toBeDefined()
  await ui.press({ key: 'welcome-ok' })
  expect(opened.slice(-3)).toEqual(['open-items', 'timeline', 'session-map'])
  await ui.unmount()

  opened.length = 0
  await start($)
  // Later sessions: all three tabs, Session map opened last so it is in front.
  await clock.settle()
  expect(opened).toEqual(['open-items', 'timeline', 'session-map'])
})

test('the timeline lists the newest moment first', async ($, on) => {
  engine(on, [])
  await start($)
  const T = 'mcp__session-map__timeline'
  await $.tool.call({ tool: T, action: 'open', title: 'First thing' } as any)
  await $.tool.call({ tool: T, action: 'step', issue: 'I1', text: 'Second thing' } as any)
  const ui = await $.ui.mount({ ...pane('timeline'), surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text', text: /^\d\d:\d\d .*I1 (First|Second) thing/ })).map((r: any) => r.text)
  expect(rows[0]).toMatch(/Second thing/)
  expect(rows[1]).toMatch(/First thing/)
  await ui.unmount()
})

const PREVIOUS = {
  'last:/proj': 'old-sess',
  'map:old-sess': {
    issues: [],
    events: [],
    seq: 0,
    items: [
      { id: 'T1', kind: 'todo', text: 'Write the migration', status: 'open', at: 5, source: 'claude' },
      { id: 'D1', kind: 'decision', text: 'Ship Friday?', options: ['Yes', 'No'], status: 'open', at: 6, source: 'claude' },
      { id: 'T2', kind: 'todo', text: 'Already finished', status: 'done', at: 7, source: 'claude' },
    ],
  },
}

test("a new session offers the last session's open items, and brings them in", async ($, on) => {
  const submitted: string[] = []
  const clock = engine(on, submitted, [], PREVIOUS)
  await start($, '/proj')
  const ui = await $.ui.mount({ ...pane('session-map'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /left 2 open items/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Already finished/ })).toBeUndefined()
  await ui.press({ key: 'carry-yes' })
  expect(await ui.find({ type: 'Text', text: /left 2 open items/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /T1 Write the migration.*↩/ })).toBeDefined()
  expect(await ui.find({ key: 'D1-o0' })).toBeDefined()
  await ui.unmount()

  // Claude is asked to check the carried items against the work, once.
  await clock.settle()
  const asks = submitted.filter(t => /brought in 2 open item/.test(t))
  expect(asks.length).toBe(1)
  expect(asks[0]).toMatch(/T1 \[todo\] Write the migration/)
  expect(asks[0]).toMatch(/D1 \[decision\] Ship Friday\?/)
  expect(asks[0]).not.toMatch(/Already finished/)
})

test('No thanks drops the offer; another folder gets no offer', async ($, on) => {
  engine(on, [], [], PREVIOUS)
  await start($, '/proj')
  const ui = await $.ui.mount({ ...pane('session-map'), surface: 'terminal' })
  await ui.press({ key: 'carry-no' })
  expect(await ui.find({ type: 'Text', text: /open item/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing open/ })).toBeDefined()
  await ui.unmount()

  // A reload runs session.start again: the answer stands.
  await start($, '/proj')
  const again = await $.ui.mount({ ...pane('session-map'), surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /open item/ })).toBeUndefined()
  await again.unmount()
})

test('a session in another folder is offered nothing', async ($, on) => {
  engine(on, [], [], PREVIOUS)
  await start($, '/elsewhere')
  const ui = await $.ui.mount({ ...pane('session-map'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing open/ })).toBeDefined()
  await ui.unmount()
})

test('work with nothing logged earns a reminder on the next prompt, once', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  engine(on, [], [], {}, contexts)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: 'done' }))
  await start($)
  const turn = () => $.turn.complete({ reason: 'answer', answer: 'done' } as any)
  const say = () => $.prompt.submit({ text: 'next' } as any)

  // A turn with no tools: no reminder.
  await turn()
  await say()
  expect(contexts.at(-1) ?? []).toEqual([])

  // Work with no issue open: reminded on the next prompt only.
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await turn()
  await say()
  expect(String(contexts.at(-1))).toMatch(/no issue is open/)
  await say()
  expect(contexts.at(-1) ?? []).toEqual([])

  // Work that logs: no reminder.
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await $.tool.call({ tool: 'mcp__session-map__timeline', action: 'open', title: 'X' } as any)
  await turn()
  await say()
  expect(contexts.at(-1) ?? []).toEqual([])

  // An issue is open: two quiet working turns pass, the third is reminded.
  for (const n of [1, 2, 3]) {
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    await turn()
    await say()
    if (n < 3) expect(contexts.at(-1) ?? []).toEqual([])
    else expect(String(contexts.at(-1))).toMatch(/last few turns/)
  }

  // A subagent's work never counts.
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as any)
  await turn()
  await say()
  expect(contexts.at(-1) ?? []).toEqual([])
})
