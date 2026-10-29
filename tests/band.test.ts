import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bgRowOf, chargesOf, endsIn, leftAt, spentText, untilOf } from '../hooks/register'

// local "HH:MM" of unix second t, as the band writes it
const hm = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5)

const T0 = 1_800_000_000 // unix s

const BAND = {
  plugin: 'detaly',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// A session 's1' in a worktree of D:\dev\game, over a progress folder of `files` (name -> job or raw text) and a
// registry of other sessions in the shared store (`sessions`: id -> what that session's mod published, as chat:<id>);
// `stored` keeps what s1 sets there.
function world(
  on: On,
  files: () => Record<string, unknown>,
  output = (path: string) => '',
  sessions: () => Record<string, unknown> = () => ({}),
  vars: Record<string, string> = {},
) {
  const clock = mock.clock(on, { now: T0 * 1000 })
  // DETALY_RUN set: the mod reloaded in a running chat (a fresh one opens minimized)
  mock.env(on, { USERPROFILE: 'C:\\Users\\u', DETALY_RUN: '1', ...vars })
  const env: Record<string, string | undefined> = {}
  const written: Record<string, string> = {}
  const stored: Record<string, unknown> = {}
  // the shared store: the other chats' entries (fresh), then what s1 wrote
  const chat = (k: string) => {
    const p = k.startsWith('chat:') ? (sessions()[k.slice(5)] as object | undefined) : undefined
    return p ? { ...p, updated: clock.now() / 1000 } : undefined
  }
  on('store.keys', () => ({ value: [...new Set([...Object.keys(sessions()).map(id => `chat:${id}`), ...Object.keys(stored)])] }))
  on('store.get', ($, e) => ({ value: stored[e.key] ?? chat(e.key) }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete stored[e.key]
    return { value: undefined }
  })
  on('env.set', ($, e) => {
    env[e.name] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'D:\\dev\\game\\.claude\\worktrees\\brave-x' }))
  // the transcript's rows, and the conversation in API form: what a test adds (`transcript`)
  const transcript: unknown[] = []
  on('session.messages', ($, e) => ({
    value: (e as { as?: string }).as === 'api'
      ? transcript
      : [
          { role: 'user', text: 'You are operating in a git worktree.', toolUses: [] }, // the engine's own row
          { role: 'user', text: '<system-reminder>notes</system-reminder>train the walking net', toolUses: [] },
        ],
  }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.render', () => ({ type: 'Box' as const })) // the engine's own (empty) band
  const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false })
  on('fs.list', ($, e) => {
    expect(e.path).toBe('C:\\Users\\u\\.claude\\progress')
    return { value: Object.keys(files()).map(entry) }
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('.output')) return { value: output(e.path) }
    const name = e.path.split(/[\\/]/).pop()!
    const f = files()[name]
    return { value: typeof f === 'string' ? f : JSON.stringify(f) }
  })
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  return { clock, env, written, stored, transcript }
}

// A background task's notification, as the engine submits it
const notify = ($: { prompt: { submit: (e: never) => Promise<unknown> } }, id: string, status = 'completed') =>
  $.prompt.submit({ text: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`, origin: { kind: 'task-notification' }, wait: false } as never)
// The conversation (API form) of a shell Claude ran in the background: its call, and the result naming its id
const launchRow = (id: string, description: string) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `u-${id}`, name: 'Bash', input: { command: 'x', description, run_in_background: true } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `u-${id}`, content: `Command running in background with ID: ${id}. Output is being written to: C:\\T\\tasks\\${id}.output` }] },
]
// a notification delivered into a turn: glued to another tool's result, as a reminder
const gluedNote = (id: string) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'u-other', content: [{ type: 'text', text: 'ok' }, { type: 'text', text: `[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` }] }],
})

test('own session and own project only; bar, percent, counts, ETA; stalled; stopped; old finished dropped', async ($, on) => {
  const job = (more: object) => ({ done: 50, total: 200, unit: 'it', started: T0 - 100, updated: T0, ...more })
  const files = {
    'train5.json': job({ title: 'train5', done: 1850, total: 3000, eta_s: 1020, session: 's1', project: 'D:\\x' }),
    'theirs.json': job({ title: 'theirs', session: 's2', project: 'D:\\dev\\game' }),
    'manual.json': job({ title: 'manual', session: null, project: 'D:\\dev\\game\\spikes\\rl', eta_s: 90 }),
    'elsewhere.json': job({ title: 'elsewhere', project: 'D:\\dev\\gameOther' }),
    'dl.json': job({ title: 'dl', unit: 'MB', updated: T0 - 90 }),
    'old.json': job({ title: 'old', finished: true, updated: T0 - 400 }),
    'cut.json': job({ title: 'cut', stopped: true, updated: T0 - 40 }), // the log's writer gone (progress_tail)
    'cutold.json': job({ title: 'cutold', stopped: true, updated: T0 - 400 }),
    'bad.json': '{"title": "half', // caught mid-write, never seen whole: no row
  }
  const { clock, env } = world(on, () => files)

  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(env.CLAUDE_JOB_SESSION).toBe('s1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // the numbers: text on the terminal, inside the bar's picture (its alt) on the desktop
    const numbers = async () => [(await ui.find({ key: 'train5' }))?.text, ...(await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)].join(' | ')
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key !== undefined && !/-name$|^tab|^group-|^info$|^stat-|^[nb]-/.test(b.key)).map(b => b.key)
    expect(rows).toEqual(['dl', 'manual', 'train5', 'cut'])
    expect((await ui.find({ key: 'cut' }))?.text).toContain(`stopped · ${hm(T0 - 40)}`) // and when: its last update
    expect((await ui.find({ key: 'train5' }))?.text).toContain('train5')
    expect(await numbers()).toContain('61 %')
    expect(await numbers()).toContain('1850 / 3000 it')
    expect((await ui.find({ key: 'train5' }))?.text).toContain(`17 min left · ${hm(T0 + 1020)}`)
    expect((await ui.find({ key: 'dl' }))?.text).toContain('stalled 2 min')
    expect((await ui.find({ key: 'manual' }))?.text).toContain('2 min left')
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 4 : 0) // a bar each, its numbers inside
    await ui.unmount()
  }
})

test('background shells: timer against the described estimate, progress from output, end from the notification', async ($, on) => {
  let output = ''
  const outputOf = (path: string) => (path.includes('aaa111') ? output : '') // the eval prints progress, the render nothing
  const { clock, transcript } = world(on, () => ({}), outputOf)
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: outputOf(e.path).length, mtimeMs: clock.now(), isLink: false } }))
  let n = 0
  on('tool.call', () => {
    n += 1
    const id = ['aaa111', 'bbb222', 'ddd444'][n - 1]
    return { result: {} as never, text: `Command running in background with ID: ${id}. Output is being written to: C:\\T\\tasks\\${id}.output` }
  })

  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'python eval.py', description: 'Eval train5, 6 tests, ~15 min', run_in_background: true })
  await $.tool.call({ tool: 'PowerShell', command: 'blender -b scene.blend -a', description: 'Render clip', run_in_background: true })
  const at = hm(T0 + 1200)
  await $.tool.call({ tool: 'Bash', command: 'sleep 1200', description: `train6 check at ~${at} (training)`, run_in_background: true })
  await clock.advance(300_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const eval5 = async () => (await ui.find({ key: 'bg-aaa111' }))?.text
  // one clock per timer row: down to its estimate, or up from its start
  expect(await eval5()).toContain(`~10 min left · ${hm(T0 + 900)}`)
  expect(await eval5()).not.toContain('5:00')
  expect((await ui.find({ key: 'bg-bbb222' }))?.text).toContain('5 min') // whole minutes: the row changes once a minute
  const check = (await ui.find({ key: 'bg-ddd444' }))?.text ?? ''
  expect(check).toContain(`train6 check (training)~15 min left · ${at}`) // the clock time leaves the title
  expect(check.split(at)).toHaveLength(2)
  const alts = async () => (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  // timers: a ring and an animated wait for a bar each
  expect(await alts()).toEqual(['31 %', '31 % of the wait', 'running', 'waiting', '25 %', '25 % of the wait'])

  output = 'loading\n 42%|████▏     | 42/100 [00:10<00:14,  4.1it/s]'
  await clock.advance(2000)
  expect(await alts()).toEqual(['42 %  42 / 100', 'running', 'waiting', '25 %', '25 % of the wait']) // counted: the dot, its numbers in the bar
  expect(await eval5()).toContain('~7 min left') // 302 s for 42 %: 417 s for the 58 % left
  expect(await eval5()).not.toContain('~42')

  await notify($, 'aaa111')
  await clock.advance(2000)
  expect(await eval5()).toContain('done')

  // a stopped shell sends no notification: the stop is its end
  await $.tool.call({ tool: 'TaskStop', task_id: 'ddd444' } as never)
  await clock.advance(2000)
  expect((await ui.find({ key: 'bg-ddd444' }))?.text).toContain('stopped after 5:0')

  // missed while the mod was away (a reload): the transcript has two more shells running and bbb222's end; ⟳ Refresh
  // reads it, follows the two (start unknown), ends bbb222, and takes the finished rows
  const later = hm(T0 + 1800)
  transcript.push(...launchRow('ccc333', 'Render video'), ...launchRow('eee555', `train7 check at ~${later}`), gluedNote('bbb222'))
  await ui.press({ key: 'refresh:s1' })
  await clock.advance(2000)
  expect((await ui.find({ key: 'bg-ccc333' }))?.text).toContain('≥ <1 min')
  expect((await ui.find({ key: 'bg-eee555' }))?.text).toContain(`train7 check~25 min left · ${later}`) // a clock time survives the reload
  expect(await ui.find({ key: 'bg-bbb222' })).toBeUndefined()
  expect(await ui.find({ key: 'bg-aaa111' })).toBeUndefined()
})

test('ETA from the rate when the job gives none; without jobs the tab row alone', async ($, on) => {
  let done = 0
  const { clock } = world(on, () =>
    done === 0 ? {} : { 'job.json': { title: 'job', done, total: 100, unit: 'it', started: T0, updated: clock.now() / 1000 } },
  )

  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // no jobs: the tab row alone
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(expect.arrayContaining(['tab:all', 'tab:s1', 'info-btn', 'mini']))
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()

  done = 10 // first seen at T0+2 s with 10 done
  await clock.advance(10_000)
  done = 20 // at T0+20 s: 10 it in 18 s, 80 left -> 144 s
  await clock.advance(10_000)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('20 %  20 / 100 it')
  expect((await ui.find({ key: 'job' }))?.text).toContain('2 min left')
})

test("a notification's status ends every task it names, the engine's note after a restart included", () => {
  expect(endsIn('<task-notification><task-id>a1</task-id><status>completed</status></task-notification>')).toEqual([['a1', 'completed']])
  const orphans = '<task-notification>\n<task-id>b1</task-id>\n<task-id>b2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>3 background shell command tasks did not finish</summary></task-notification>'
  expect(endsIn(orphans)).toEqual([['b1', 'stopped'], ['b2', 'stopped'], ['__orphan_summary__:shell', 'stopped']])
  expect(endsIn(`${orphans} <task-notification><task-id>c1</task-id><status>failed</status></task-notification>`).at(-1)).toEqual(['c1', 'failed'])
})

test('the end time names a later day', () => {
  const late = new Date(2027, 0, 15, 23, 50).getTime() / 1000
  expect(leftAt(late, 1800)).toBe('30 min left · 00:20 +1d')
  expect(leftAt(late, 300)).toBe('5 min left · 23:55')
})

test('a clock time in the description is the end', () => {
  expect(untilOf(T0, `train6 check at ~${hm(T0 + 1200)} (training)`)).toBe(1200)
  expect(untilOf(T0, `render, до ${hm(T0 - 3600)}`)).toBe(82_800) // passed today: tomorrow
  expect(untilOf(T0, 'ETA 0:12:00')).toBeUndefined()
  expect(untilOf(T0, 'train6 ~40 min')).toBeUndefined()
})

test("a described end outweighs a percent in the output (a part of the job's)", () => {
  const t = { title: 'After train8: full eval', started: T0 - 1800, expectS: 3600, isUntil: true }
  const row = bgRowOf('t9', t, T0, 'eval  2%|▏         | 3/150')
  expect(row?.isTimer).toBe(true)
  expect(row?.tail).toBe(`~30 min left · ${hm(T0 + 1800)}`)
})

test('minimized: the session figures over this chat\'s rows', async ($, on) => {
  const { clock } = world(on, () => ({ 'a.json': { title: 'Resize images', done: 5, total: 10, updated: T0, started: T0 - 10, session: 's1' } }))
  on('session.usage', () => ({
    value: {
      startedAt: (T0 - 7200) * 1000,
      context: { tokens: 148_000, window: 1_000_000, percent: 15 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 2, resetsAt: new Date((T0 + 3600) * 1000).toISOString() },
        { kind: 'seven_day', percentUsed: 24 },
      ],
      cost: { usd: 4.1 },
    },
  }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  // the tabs: the same figures in ⓘ Info's card
  expect(await ui.find({ key: 'info-btn' })).toBeDefined()
  await ui.press({ key: 'info-btn' }) // pinned: shown for good, no hover to reveal it (the engine refuses one)
  const pinned = (await ui.findAll({ type: 'Box' })).find(b => b.props.position === 'absolute' && /5-hour limit/.test(b.text ?? ''))
  expect(pinned?.props).toMatchObject({ display: 'flex' })

  await ui.press({ key: 'info-btn' })
  expect(await texts()).toContain(`5-hour limit 2 % · resets ${hm(T0 + 3600)}`)
  await ui.press({ key: 'mini' })
  expect(await texts()).toEqual(expect.arrayContaining(['ctx 15%', '5h 2%', 'week 24%', '$4.10']))
  // a limit's ring, filled to its share
  const rings = (await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'week 24%')
  expect(rings).toHaveLength(1)
  expect(String(rings[0]?.props.source)).toContain('#4A8FE7')
  expect(await texts()).toContain(`5-hour limit 2 % · resets ${hm(T0 + 3600)}`) // the hover card
})

test('minimized with no jobs of its own: the strip stays, figures and ▴ Tabs', async ($, on) => {
  const { clock } = world(on, () => ({}))
  on('session.usage', () => ({ value: { startedAt: T0 * 1000, context: { window: 1_000_000, percent: 3 }, rateLimits: [] } }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.command.run({ command: 'detaly', args: '' } as never)
  await ui.press({ key: 'mini' })
  expect(await ui.find({ type: 'Text', text: 'ctx 3%' })).toBeDefined()
  expect(await ui.find({ key: 'expand' })).toBeDefined()
})

test('background shells outlive a reload of the mod: they are kept in the session state', async ($, on) => {
  const { clock } = world(on, () => ({}))
  // what a previous load of the mod kept: a render started 2 min before this load, until a clock time
  const end = hm(T0 + 600)
  const kept = [['fff666', { title: 'Render a5', started: T0 - 120, expectS: 720, isUntil: true }]]
  const writes: unknown[] = []
  on('state.get', ($, e, next) => (e.key === 'tasks' ? { value: { value: kept, version: 1 } } : next(e)) as never)
  on('state.set', ($, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'bg-fff666' }))?.text).toContain(`Render a5~10 min left · ${end}`)
  await notify($, 'fff666')
  expect(writes.at(-1)).toEqual([['fff666', expect.objectContaining({ endedAt: T0, status: 'completed' })]])
})

test('a quick task never shows; a finished one stays as long as it ran (15 s to 10 min)', async ($, on) => {
  const { clock } = world(on, () => ({}))
  let n = 0
  on('tool.call', () => {
    n += 1
    return { result: {} as never, text: `Command running in background with ID: q${n}. Output is being written to: C:\T\tasks\q${n}.output` }
  })
  const end = (id: string) =>
    notify($, id)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 5', description: 'Quick wait', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60', description: 'Minute wait', run_in_background: true })
  await clock.advance(6000)
  expect(await ui.find({ key: 'bg-q1' })).toBeUndefined() // under 10 s: not shown
  await end('q1')
  await clock.advance(6000)
  expect(await ui.find({ key: 'bg-q1' })).toBeUndefined() // ended under 10 s: never shown
  expect(await ui.find({ key: 'bg-q2' })).toBeDefined()
  await clock.advance(48_000)
  await end('q2')
  await clock.advance(50_000)
  expect((await ui.find({ key: 'bg-q2' }))?.text).toContain(`done in 1:00 · ${hm(T0 + 60)}`)
  await clock.advance(12_000)
  expect(await ui.find({ key: 'bg-q2' })).toBeUndefined() // ran 60 s: gone 60 s after its end
})

test("a finished row leaves 10 min of the person's time after they first saw it; unseen, it waits", async ($, on) => {
  const { clock, stored } = world(on, () => ({}), () => '', () => ({}), { OS: 'Windows_NT' })
  on('tool.call', () => ({ result: {} as never, text: 'Command running in background with ID: w1. Output is being written to: C:\\T\\tasks\\w1.output' }))
  // the presence watcher answers once; then the clock is set by hand, kept fresh, as another chat's watcher would
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '0 claude\n' }
    return { code: 0, signal: null }
  })
  let activeS = 0
  let here = false
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 10_000) {
      stored.presence = { activeS, at: clock.now() / 1000, by: 's2', here }
      await clock.advance(10_000)
    }
  }
  const published = () => ((stored['chat:s1'] as { rows: { id: string }[] } | undefined)?.rows ?? []).map(r => r.id)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'python train.py', description: 'Train walk20', run_in_background: true })
  await step(900_000) // ran 15 min: stays 10 min of the person's time once seen
  await notify($, 'w1')
  // at Claude for 20 min, but this chat's band is not on screen: never drawn, not seen
  here = true
  for (let i = 0; i < 120; i++) {
    activeS += 10
    await step(10_000)
  }
  expect(published()).toContain('bg-w1')
  expect(stored['seen:bg-w1']).toBeUndefined()
  // the band shows it: seen now; 10 min of the person's time later it leaves
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await step(20_000)
  expect(stored['seen:bg-w1']).toMatchObject({ active: activeS })
  activeS += 590
  await step(20_000)
  expect((await ui.find({ key: 'bg-w1' }))?.text).toContain('done in 15:00')
  activeS += 20
  await step(20_000)
  expect(await ui.find({ key: 'bg-w1' })).toBeUndefined()
  expect(stored['seen:bg-w1']).toBeUndefined() // its mark goes with it
})

test('a name is one line; one too long for its column shows whole in a card while hovered', async ($, on) => {
  const long = 'Export all frames of the RE-style video to PNG for review, then pack them into an atlas'
  const { clock } = world(on, () => ({
    'a.json': { title: 'short', done: 1, total: 2, updated: T0, started: T0 - 10 },
    'c.json': { title: 'Resize images ~6 min', done: 1, total: 2, updated: T0, started: T0 - 10 }, // 20 letters in 18 cells: fits drawn
    'b.json': { title: long, done: 1, total: 2, updated: T0, started: T0 - 10 },
  }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // a name card: hidden, lifted by the desktop out of the name's cell while it is hovered
  const titles = ['short', 'Resize images ~6 min', long]
  const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.display === 'none' && b.props.position === 'absolute' && titles.includes(b.text ?? ''))
  expect(cards).toHaveLength(1) // the names that fit need none
  expect(cards[0]?.text).toBe(long)
})

test('a ✖ at the row's end on hover: a finished row leaves at once, a running one after "stop tracking? yes"', async ($, on) => {
  const { clock } = world(on, () => ({
    'run.json': { title: 'running', done: 1, total: 2, updated: T0, started: T0 - 10 },
    'old.json': { title: 'finished', done: 2, total: 2, updated: T0, started: T0 - 60, finished: true },
  }))
  on('tool.call', () => ({ result: {} as never, text: 'Command running in background with ID: zz1. Output is being written to: C:\T\zz1.output' }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 30', description: 'Render', run_in_background: true })
  await clock.advance(30_000)
  await notify($, 'zz1')
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'x-run' }) // running: asks first
  expect((await ui.find({ key: 'run' }))?.text).toContain('Stop tracking')
  await ui.press({ key: 'no-run' })
  expect((await ui.find({ key: 'run' }))?.text).not.toContain('Stop tracking')
  await ui.press({ key: 'x-bg-zz1' })
  expect(await ui.find({ key: 'bg-zz1' })).toBeUndefined()
  await ui.press({ key: 'x-old' })
  expect(await ui.find({ key: 'old' })).toBeUndefined()
  await clock.advance(2000)
  expect(await ui.find({ key: 'old' })).toBeUndefined() // stays hidden: the same run
  await ui.press({ key: 'x-run' })
  await ui.press({ key: 'yes-run' })
  await clock.advance(2000)
  expect(await ui.find({ key: 'run' })).toBeUndefined() // still running, no longer followed
})

test("tabs: this chat, All, and another chat that publishes its jobs; a tab's Close, All's Refresh brings it back", async ($, on) => {
  const other = {
    session: 's2',
    label: 'website · render the trailer',
    updated: T0,
    rows: [{ id: 'bg-r1', title: 'Render trailer', f: 0.5, counts: '50 / 100', tail: '~1 min left · 11:01', state: 'run' }],
  }
  const { clock, stored, transcript } = world(
    on,
    () => ({ 'mine.json': { title: 'Resize images', done: 5, total: 10, updated: T0, started: T0 - 10, session: 's1' } }),
    () => '',
    () => ({ s2: other }),
  )
  on('tool.call', () => ({ result: {} as never, text: 'Command running in background with ID: t1. Output is being written to: C:\T\t1.output' }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // what this chat publishes for the others: its label (folder and first message) and its background shells
  const mine = (stored['chat:s1'] ?? {}) as { label?: string }
  expect(mine.label).toBe('game · train the walking net')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const tabs = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('tab:'))
  expect(await tabs()).toEqual(['tab:all', 'tab:s1', 'tab:s2'])
  expect(await ui.find({ key: 'mine' })).toBeDefined() // this chat's tab is open
  expect(await ui.find({ key: 's2:bg-r1' })).toBeUndefined()

  await ui.press({ key: 'tab:s2' })
  expect(await ui.find({ key: 's2:bg-r1' })).toBeDefined()
  expect(await ui.find({ key: 'mine' })).toBeUndefined()

  await ui.press({ key: 'tab:all' }) // every chat, a heading each
  expect(await ui.find({ key: 'mine' })).toBeDefined()
  expect(await ui.find({ key: 's2:bg-r1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'website · render the trailer' })).toBeDefined()

  expect(await ui.find({ key: 'close:s1' })).toBeUndefined() // this chat's tab does not close
  await ui.press({ key: 'close:s2' }) // closed: its tab and its rows leave
  expect(await tabs()).toEqual(['tab:all', 'tab:s1'])
  expect(await ui.find({ key: 's2:bg-r1' })).toBeUndefined()

  // a running shell this chat stopped following comes back with its tab's Refresh; All's Refresh brings the closed tab
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Bake lightmaps', run_in_background: true })
  await clock.advance(12_000)
  transcript.push(...launchRow('t1', 'Bake lightmaps'))
  await ui.press({ key: 'x-bg-t1' })
  await ui.press({ key: 'yes-bg-t1' })
  expect(await ui.find({ key: 'bg-t1' })).toBeUndefined()
  await ui.press({ key: 'refresh:s1' })
  expect(await ui.find({ key: 'bg-t1' })).toBeDefined()
  expect(await tabs()).toEqual(['tab:all', 'tab:s1'])
  await ui.press({ key: 'refresh:all' })
  expect(await tabs()).toEqual(['tab:all', 'tab:s1', 'tab:s2'])
})

test("a tab's Refresh takes its finished rows; on another chat's tab it asks that chat to sync itself", async ($, on) => {
  const other = {
    session: 's2',
    label: 'website · x',
    updated: T0,
    rows: [
      { id: 'bg-r1', title: 'Render', f: 0.5, counts: '', tail: '', state: 'run' },
      { id: 'bg-r2', title: 'Encode', f: 1, counts: '', tail: 'done', state: 'done' },
    ],
  }
  const { clock, stored } = world(
    on,
    () => ({
      'a.json': { title: 'Resize images', done: 5, total: 10, updated: T0, started: T0 - 10, session: 's1' },
      'b.json': { title: 'Pack atlas', done: 10, total: 10, updated: T0, started: T0 - 10, session: 's1', finished: true },
    }),
    () => '',
    () => ({ s2: other }),
  )
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'refresh:s1' }) // this chat's finished row leaves, the running one stays
  expect(await ui.find({ key: 'b' })).toBeUndefined()
  expect(await ui.find({ key: 'a' })).toBeDefined()
  await ui.press({ key: 'tab:s2' })
  await ui.press({ key: 'refresh:s2' }) // its finished row hidden here, and a request s2's mod picks up
  expect(await ui.find({ key: 's2:bg-r2' })).toBeUndefined()
  expect(await ui.find({ key: 's2:bg-r1' })).toBeDefined()
  expect(stored['sync:s2']).toBeDefined()
})

test('an end glued into a turn is read after it; a shell followed blind that the conversation no longer holds ends', async ($, on) => {
  const { clock, transcript } = world(on, () => ({}))
  on('tool.call', () => ({ result: {} as never, text: 'Command running in background with ID: g1. Output is being written to: C:\\T\\tasks\\g1.output' }))
  // followed before a reload, start unknown, and gone from the conversation (a compaction took its launch)
  const kept = [['old1', { title: 'Hover test', started: T0 - 600, isLate: true }]]
  let isRead = false // the load reads it once; later reads see what the mod wrote
  on('state.get', ($, e, next) => (e.key === 'tasks' && !isRead && (isRead = true) ? { value: { value: kept, version: 0 } } : next(e)) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60', description: 'Wait for the eval', run_in_background: true })
  transcript.push(...launchRow('g1', 'Wait for the eval'))
  await clock.advance(30_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'bg-old1' }))?.text).toContain('ended after')
  expect((await ui.find({ key: 'bg-g1' }))?.text).toContain('<1 min') // still running
  // its notification came glued to another tool's result, inside a turn: read once the turn ends
  transcript.push(gluedNote('g1'))
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false } as never)
  await clock.advance(2000)
  expect((await ui.find({ key: 'bg-g1' }))?.text).toContain('done in 0:30')
})

test("the chats' tabs shrink their names to share the row between All and ⓘ Info", async ($, on) => {
  const chat = (id: string) => ({ session: id, label: `website · render the trailer for ${id}`, updated: T0, rows: [{ id: 'bg-r', title: 'Render', f: 0.5, counts: '', tail: '', state: 'run' }] })
  const { clock } = world(on, () => ({}), () => '', () => ({ s2: chat('s2'), s3: chat('s3'), s4: chat('s4'), s5: chat('s5') }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const names = async (columns: number) => {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns }, surface: 'desktop' })
    await ui.press({ key: 'tab:all' })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => b.key)).toEqual(expect.arrayContaining(['tab:all', 'tab:s1', 'tab:s5', 'info-btn', 'mini']))
    const texts = buttons.filter(b => /^tab:s[2-5]$/.test(b.key ?? '')).map(b => (b.text ?? '').replace(/ \d+$/, ''))
    await ui.unmount()
    return texts
  }
  for (const t of await names(200)) expect(t).toBe('website · render the tr…') // room: 24 letters each, the … one
  const narrow = await names(100) // 5 named tabs: (100 - 24 - 9 - 5 * 6) / 5 = 7
  for (const t of narrow) expect(t).toBe('websit…')
})

test("a chat's process started afresh opens the band minimized on this chat; a reload keeps its tab and mode", async ($, on) => {
  const { clock, env } = world(on, () => ({ 'a.json': { title: 'Resize images', done: 5, total: 10, updated: T0, started: T0 - 10, session: 's1' } }), () => '', () => ({}), { DETALY_RUN: '' })
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'expand' })).toBeDefined() // ▴ Tabs: minimized
  expect(await ui.find({ key: 'tab:all' })).toBeUndefined()
  expect(env.DETALY_RUN).toBe('1') // a reload in this process now keeps what is open
})

test('minimized: this chat alone, no tabs; ▴ brings them back', async ($, on) => {
  const other = { session: 's2', label: 'website · x', updated: T0, rows: [{ id: 'bg-r1', title: 'Render', f: 0.5, counts: '', tail: '', state: 'run' }] }
  const { clock } = world(
    on,
    () => ({ 'a.json': { title: 'Resize images', done: 5, total: 10, updated: T0, started: T0 - 10, session: 's1' } }),
    () => '',
    () => ({ s2: other }),
  )
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'tab:all' })
  await ui.press({ key: 'mini' })
  expect(await ui.find({ key: 'tab:all' })).toBeUndefined()
  expect(await ui.find({ key: 's2:bg-r1' })).toBeUndefined()
  expect(await ui.find({ key: 'a' })).toBeDefined()
  await ui.press({ key: 'refresh-mini' }) // this chat's refresh, the band stays minimized
  expect(await ui.find({ key: 'a' })).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 's2:bg-r1' })).toBeDefined() // back on the tab it was on
})

test('the band never outgrows its room: thin rows, then pages', async ($, on) => {
  const jobs: Record<string, unknown> = {}
  for (let i = 0; i < 8; i++) jobs[`j${i}.json`] = { title: `Job ${i}`, done: i, total: 10, updated: T0, started: T0 - 10, session: 's1' }
  const { clock } = world(on, () => jobs)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  // 8 job rows under the tabs and their gap, in a band of 10 less a row of slack: 7 lines; two-line rows overflow, so
  // the rows go thin (one line), 7 a page
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 10 }, surface: 'desktop' })
  const order = async () =>
    (await ui.findAll({ type: 'Box' }))
      .map(b => b.key ?? '')
      .filter(k => /^(j\d+|tab-all|head-s1|pad)$/.test(k))
      .join(' ')
  const open = (page: number) => ui.post({ page }, { in: 'pager' })
  expect(await order()).toBe('tab-all j0 j1 j2 j3 j4 j5 j6')
  expect((await ui.find({ key: 'j0' }))?.props.height).toBe(1)
  expect((await ui.find({ key: 'pager' }))?.props).toMatchObject({ props: { page: 0, pages: 2, rows: 7 } })
  await open(1)
  expect(await order()).toBe('tab-all j7 pad') // every page as tall as the room
  // All: a page that opens inside a chat's rows repeats its heading
  await ui.press({ key: 'tab:all' })
  expect(await order()).toBe('tab-all head-s1 j0 j1 j2 j3 j4 j5')
  await open(1)
  expect(await order()).toBe('tab-all head-s1 j6 j7 pad')
})

test('a page holds 10 job rows at most; rows that fit stay two lines tall', async ($, on) => {
  const jobs: Record<string, unknown> = {}
  for (let i = 0; i < 12; i++) jobs[`j${i}.json`] = { title: `Job ${i}`, done: i, total: 20, updated: T0, started: T0 - 10, session: 's1' }
  const { clock } = world(on, () => jobs)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 40 }, surface: 'desktop' })
  const keys = async () =>
    (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => /^j\d+$/.test(k))
  // 12 two-line rows fit 37 lines, but a page holds 10: two pages, the rows two lines tall
  expect(await keys()).toHaveLength(10)
  expect((await ui.find({ key: 'j0' }))?.props.height).toBe(2)
  await ui.post({ page: 1 }, { in: 'pager' })
  expect(await keys()).toHaveLength(2) // the files come by name: j0 j1 j10 j11 j2 …
  // 12 thin rows in 17 lines: 10, then 2
  await ui.unmount()
  const small = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 20 }, surface: 'desktop' })
  const small_keys = async () => (await small.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => /^j\d+$/.test(k))
  await small.post({ page: 0 }, { in: 'pager' }) // the open page is the band's, kept across drawings
  expect(await small_keys()).toHaveLength(10)
  expect((await small.find({ key: 'j0' }))?.props.height).toBe(1)
  await small.post({ page: 1 }, { in: 'pager' })
  expect(await small_keys()).toHaveLength(2)
})

test('/detaly opens the All tab, in a chat with no jobs of its own too', async ($, on) => {
  const other = { session: 's2', label: 'website · x', updated: T0, rows: [{ id: 'bg-r1', title: 'Render', f: 0.5, counts: '', tail: '', state: 'run' }] }
  const { clock } = world(on, () => ({}), () => '', () => ({ s2: other }))
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 's2:bg-r1' })).toBeUndefined() // nothing of its own: no band
  await $.command.run({ command: 'detaly', args: '' } as never)
  await clock.advance(2000)
  expect(await ui.find({ key: 's2:bg-r1' })).toBeDefined()
})

test("a response is charged to the shells it launches, names, or was woken by, and to the file jobs it names", () => {
  const ids = ['bq1', 'bq2', 'bq3']
  const uses = [
    { name: 'Read', input: { file_path: 'C:\T\tasks\bq2.output' } },
    { name: 'Bash', input: { command: 'sleep 99', run_in_background: true } },
    { name: 'Bash', input: { command: 'ls' } },
  ]
  expect(chargesOf(uses, ids, ['bq1'])).toEqual({ named: ['bq1', 'bq2'], launches: 1, jobs: [] })
  expect(chargesOf([], ids, [])).toEqual({ named: [], launches: 0, jobs: [] })
  // a job by its id as a word: walk14's log, not walk14b's
  const watch = [{ name: 'Bash', input: { command: 'python rl/watch.py D:/runs/walk14_train.log' } }]
  const jobs = ['walk14@100', 'walk1@50', 'walk14b@200']
  expect(chargesOf(watch, [], [], jobs).jobs).toEqual(['walk14@100'])
  expect(spentText({ tokensIn: 1_234_567, out: 4_100, usd: 0.834, steps: 3 })).toBe('Claude on it: $0.83 · 1.2M in · 4k out · 3 responses')
})

test("a shell's row carries what Claude spent on it, in a card while hovered", async ($, on) => {
  const { clock } = world(on, () => ({}))
  const kept = [['fff777', { title: 'Render a6', started: T0 - 120, expectS: 600, spent: { tokensIn: 50_000, out: 900, usd: 0.12, steps: 1 } }]]
  on('state.get', ($, e, next) => (e.key === 'tasks' ? { value: { value: kept, version: 1 } } : next(e)) as never)
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Claude on it: $0.12 · 50k in · 900 out · 1 response')
})

test('a shell launched while its response still streams is charged that response', async ($, on) => {
  const { clock } = world(on, () => ({}))
  let usd = 1
  on('session.usage', () => ({ value: { startedAt: T0 * 1000, context: { window: 1_000_000, percent: 3 }, rateLimits: [], cost: { usd } } }))
  on('tool.call', () => ({ result: {} as never, text: 'Command running in background with ID: ggg888. Output is being written to: C:\\T\\tasks\\ggg888.output' }))
  const input = { command: 'python train.py', description: 'Train walk13', run_in_background: true }
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'Starting it.' }
    usd = 1.25
    const usage = { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, output_tokens: 300, model: 'm' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input }], stopReason: 'tool_use' as const, usage }
  })
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  await step.next() // the response is streaming
  await $.tool.call({ tool: 'Bash', ...input }) // the engine runs a call as soon as it is whole, before the response ends
  for await (const _ of step);
  await step.result
  await clock.advance(12_000) // a shell shows once it has run 10 s
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Claude on it: $0.25 · 40k in · 300 out · 1 response')
})

test("a file job's card: its run, and what the responses that name it cost, published for the other chats", async ($, on) => {
  const job = { title: 'walk14', done: 600, total: 3000, unit: 'it', started: T0 - 300, updated: T0, session: 's1' }
  const { clock, stored } = world(on, () => ({ 'walk14.json': job }))
  let usd = 2
  on('session.usage', () => ({ value: { startedAt: T0 * 1000, context: { window: 1_000_000, percent: 3 }, rateLimits: [], cost: { usd } } }))
  const input = { command: 'python rl/watch.py ../../results/rl/walk14_train.log' }
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'Checking.' }
    usd = 2.1
    const usage = { input_tokens: 5, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0, output_tokens: 200, model: 'm' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input }], stopReason: 'tool_use' as const, usage }
  })
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of step);
  await step.result
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain(`Started ${hm(T0 - 300)} · running 5 min · 2.0 it/s`)
  expect(texts).toContain('Claude on it: $0.10 · 80k in · 200 out · 1 response')
  expect((stored[`chat:s1`] as { jobs?: object }).jobs).toEqual({ [`walk14@${T0 - 300}`]: 'Claude on it: $0.10 · 80k in · 200 out · 1 response' })
})

test("a chat silent for an hour leaves the shared store; one that ends takes its own entry out", async ($, on) => {
  const { clock, stored } = world(on, () => ({}))
  on('session.end', () => ({ sessionId: 's1' }) as never) // the engine's own end
  stored['chat:old'] = { session: 'old', label: 'gone · long ago', updated: T0 - 7200, rows: [] }
  stored['sync:old'] = T0 * 1000 - 7_200_000
  await $.session.start({ cwd: 'C:/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(stored['chat:old']).toBeUndefined()
  expect(stored['sync:old']).toBeUndefined()
  expect(stored['chat:s1']).toBeDefined() // this chat's own, published
  await $.session.end({ reason: 'other' } as never)
  expect(stored['chat:s1']).toBeUndefined()
})
