import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { JobProgressTask, Spent } from '../types'

// One file per job in ~/.claude/progress/<id>.json, written by the job (bin/progress.py, bin/progress_tail.ps1):
// { title, done, total, unit, started, eta_s, updated, finished, stopped, session, project }, times in unix seconds.
// `session`: the Claude session that launched the job (CLAUDE_JOB_SESSION, set below for everything this session
// starts); `project`: where the job runs, for jobs started outside Claude.
type Job = {
  title?: string
  done?: number
  total?: number
  unit?: string
  started?: number
  eta_s?: number | null
  updated?: number
  finished?: boolean
  stopped?: boolean // ended before its total (progress_tail: the log's writer is gone)
  session?: string | null
  project?: string | null
}
type Bg = JobProgressTask // a background shell of this session (types/index.d.ts)
type State = 'run' | 'stale' | 'done' | 'fail' | 'stop' // stop: stopped on purpose, kept and dropped like done
// isTimer: time, not counted work: a ring in place of the dot and a wait bar (filled to f, or sweeping without f)
// `spent`: what Claude's responses about the job cost; `info`: a file job's start, run time and rate; both in a card
// while the row is hovered. `seen`: a finished row's key in the store's `seen:` entries
type Row = { id: string; title: string; f: number | undefined; counts: string; tail: string; state: State; isTimer?: boolean; spent?: string; info?: string; seen?: string }

const TICK_MS = 2000
const STALE_S = 60 // no update for this long: stalled
// A finished row stays as long as the job ran, 15 s to KEEP_FINISHED_S, counted on the presence clock from when the
// person first saw it: drawn on the band's open page while they were at Claude. Unseen, it waits for them.
const KEEP_FINISHED_S = 600
const KEEP_ENDED_S = 12 * 3600 // a finished file job's file is read this long at most, waiting for the person
const SHOW_AFTER_S = 10 // a background task shows once it has run this long
const KEEP_S = 3600 // an unfinished job's file not touched for this long is dropped (a crashed job)
const OUTPUT_MAX = 1 << 20 // a task's output is parsed for progress while under this size

// A tab of the band: this session's jobs, another session's (from what its own mod publishes), or file jobs of a
// project with no session.
type Group = { id: string; label: string; rows: Row[]; isSelf?: boolean }
// What a session's mod publishes for the others, in the store every session on the machine shares ($.store, key
// chat:<id>): rewritten when its rows change and every PUBLISH_S, so an entry gone quiet past ALIVE_S is a closed chat,
// and past FORGET_S it is deleted (by whichever chat sees it), as a chat's own is when it ends. sync:<id> holds the
// last sync another chat's ⟳ Refresh asked of it. Files could not be deleted ($.fs has no delete), so they piled up.
// `jobs`: what Claude spent on its file jobs (by "<id>@<started>"), which the other chats read from the files themselves
type Published = { session: string; label: string; updated: number; rows: Row[]; jobs?: Record<string, string> }
const PUBLISH_S = 10
const ALIVE_S = 60
const FORGET_S = 3600

let groups: Group[] = []
let selfId = '' // this session
let label = '' // this session's tab: "<folder> · <start of its first message>"
let published = ''
let publishedAt = 0
const lastPub = new Map<string, { mtime: number; v: Published }>() // read again only when the file moved
let runNow: (() => Promise<void>) | undefined // the tick, for a press that should show at once
let progressDir = '' // ~/.claude/progress
let syncSeen: number | undefined // when the last sync request another chat left for this one was made (undefined: not listed yet)
let folder = '' // this session's project folder
const lastGood = new Map<string, { mtime: number; v: Job }>() // read again only when the file moved
const seenAt = new Map<string, number>() // the presence clock when a finished row was first seen, by its `seen` key
const marked = new Set<string>() // the rows this chat has marked seen
// a task's output, read whole (no partial reads): its last line (all the progress lives in), its size then, when
const lastLine = new Map<string, { size: number; at: number; line: string }>()
const BIG_OUTPUT = 64 << 10 // a growing output past this is read again every BIG_EVERY_S at most
const BIG_EVERY_S = 10
const firstSeen = new Map<string, { t: number; done: number }>() // the rate is measured from here
const isOver = (r: Row) => r.state === 'done' || r.state === 'fail' || r.state === 'stop'
// Rows the person dismissed: "bg-<id>" for a background task, "<id>@<started>" for a file job (a new run of it shows
// again). ponytail: module memory, so a reload of the mod shows a dismissed file job again until its file goes quiet
// for an hour. Upgrade: keep them in $.state beside the tasks.
const gone = new Set<string>()
let asking: string | undefined // the running row whose "stop tracking?" is on screen
// The session's background shells: worked on here, kept in $.state so a reload of the mod (an update) keeps them.
const bg = new Map<string, Bg>()
const tasks = atom({ plugin: 'detaly', key: 'tasks' } as const, [] as [string, Bg][])
function save($: EngineInterface) {
  return update($, tasks, () => [...bg])
}

const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1))

const dur = (s: number) => {
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  const m = Math.round(s / 60)
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

const clock = (s: number) => {
  const t = Math.floor(s)
  const mm = String(Math.floor(t / 60) % 60).padStart(t >= 3600 ? 2 : 1, '0')
  return `${t >= 3600 ? `${Math.floor(t / 3600)}:` : ''}${mm}:${String(t % 60).padStart(2, '0')}`
}

// the local clock time `dt` s from now: "17:42", "09:10 +1d" on a later day, "22:30 -1d" on an earlier one
const clockAt = (now: number, dt: number) => {
  const end = new Date((now + dt) * 1000)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(end) - day(new Date(now * 1000))) / 86_400_000)
  const hm = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
  return `${hm}${days > 0 ? ` +${days}d` : days < 0 ? ` ${days}d` : ''}`
}
// "17 min left · 17:42": what is left and the local clock time it ends at
// `isCoarse`: whole minutes ("<1 min"), so a timer's row changes once a minute, not every tick
export const leftAt = (now: number, left: number, isCoarse = false) => `${isCoarse ? coarse(left) : dur(left)} left · ${clockAt(now, left)}`
const coarse = (s: number) => (s < 60 ? '<1 min' : dur(s))

// "~15 min", "1 h 20 min", "90 s", "~2ч": the duration a description names, in seconds
export const expectOf = (text: string) => {
  let s = 0
  for (const [, n = '', unit = ''] of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-zа-я]+)/giu)) {
    const x = Number(n.replace(',', '.'))
    const u = unit.toLowerCase()
    if (/^(h|hr|hrs|hours?|ч|час\p{L}*)$/u.test(u)) s += x * 3600
    else if (/^(m|min|mins|minutes?|мин\p{L}*)$/u.test(u)) s += x * 60
    else if (/^(s|sec|secs|seconds?|с|сек\p{L}*)$/u.test(u)) s += x
  }
  return s > 0 ? s : undefined
}

// Progress in a task's last output line: "42%" or "12/100" (tqdm, most CLIs)
const lastLineOf = (text: string) => text.split(/[\r\n]+/).filter(l => l.trim()).pop() ?? ''
export const progressOf = (output: string) => {
  const line = lastLineOf(output)
  const kn = [...line.matchAll(/(?:^|[\s[(|])(\d+)\s*\/\s*(\d+)(?=$|[\s\])|,:])/g)].pop()
  if (kn && Number(kn[2]) > 0 && Number(kn[1]) <= Number(kn[2])) return { f: Number(kn[1]) / Number(kn[2]), counts: `${kn[1]} / ${kn[2]}` }
  const pct = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].pop()
  if (pct && Number(pct[1]) <= 100) return { f: Number(pct[1]) / 100, counts: '' }
  return undefined
}

// "at ~18:10", "until 17:25", "до 18:10": seconds from now to that local clock time (tomorrow once it has passed)
const UNTIL = /(?:\b(?:at|until|till|by)|(?:^|\s)(?:до|к|в))\s*~?\s*(\d{1,2}):(\d{2})(?![:\d])/iu
export const untilOf = (now: number, text: string) => {
  const m = UNTIL.exec(text)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined
  const end = new Date(now * 1000)
  end.setHours(Number(m[1]), Number(m[2]), 0, 0)
  const s = end.getTime() / 1000 - now
  return s < -60 ? s + 86_400 : s > 0 ? s : undefined
}

// A task seen at `now`: a clock time its description names leaves the title (the row ends with it) and is the end,
// exact even when the start is unknown (`isUntil`); else a duration it names, counted from the start.
function trackOf(now: number, description: string, more: Partial<Bg>): Bg {
  const until = untilOf(now, description)
  if (until === undefined) return { title: description, started: now, expectS: more.isLate ? undefined : expectOf(description), ...more }
  const title = description.replace(UNTIL, '').replace(/\s{2,}/g, ' ').replace(/[\s,;:]+$/, '') || description
  return { title, started: now, expectS: until, isUntil: true, ...more }
}

// A background task's end as its notification says it: <task-id>, then <status>.
const NOTE = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

// What the transcript says of this session's background shells: each launch (a Bash or PowerShell call run in the
// background, its result naming the id), each end (a notification, a TaskStop or KillShell). Read when the mod loads
// and at ⟳ Refresh, in place of the list of what still runs that a turn's end (classic.Stop) carried: a security
// default seated for an organization keeps classic events, and the notifications' rows, from a person's mods. Shells
// still running that the mod does not follow (missed, or dismissed while running) are followed again, start unknown;
// followed ones that ended are ended.
async function reconcile($: EngineInterface) {
  const msgs = await $.session.messages().catch(() => [])
  const launches = new Map<string, { title: string; output?: string }>()
  const ends = new Map<string, string>()
  for (const m of msgs) {
    for (const [, id = '', status = ''] of m.text.matchAll(NOTE)) ends.set(id, status)
    for (const u of m.toolUses) {
      const input = u.input as { run_in_background?: unknown; description?: unknown; command?: unknown; task_id?: unknown; shell_id?: unknown }
      if (/^(Bash|PowerShell)$/.test(u.tool) && input.run_in_background === true) {
        const id = /with ID: (\w+)/.exec(u.text ?? '')?.[1]
        const title = String(input.description ?? '').trim() || String(input.command ?? '').slice(0, 60)
        if (id) launches.set(id, { title, output: /written to: (.+?\.output)/.exec(u.text ?? '')?.[1] })
      } else if (/^(TaskStop|KillShell)$/.test(u.tool) && !u.isError) ends.set(String(input.task_id ?? input.shell_id ?? ''), 'stopped')
    }
  }
  const now = (await $.clock.now()) / 1000
  let isChanged = false
  for (const [id, l] of launches)
    if (!ends.has(id) && !bg.has(id) && !gone.has(`bg-${id}`)) {
      bg.set(id, trackOf(now, l.title, { isLate: true, output: l.output }))
      isChanged = true
    }
  for (const [id, t] of bg) {
    const status = ends.get(id)
    if (t.endedAt === undefined && status) {
      Object.assign(t, { endedAt: now, status })
      isChanged = true
    }
  }
  if (isChanged) await save($)
}

// A background shell's launch: its result names the task id and the file its output goes to.
function launched(now: number, description: string | undefined, command: string, text: string | undefined) {
  const id = text ? /with ID: (\w+)/.exec(text)?.[1] : undefined
  if (!id) return
  bg.set(id, trackOf(now, description?.trim() || command.slice(0, 60), { output: /written to: (.+?\.output)/.exec(text ?? '')?.[1] }))
  return id
}

// What Claude's responses about a background shell cost. A response is charged to the shells it launches, the ones its
// tool calls name (their id is in the output file's name too), and, through a turn the shells' ends woke, to those;
// split evenly when it is several. Its dollars are the session's cost before and after it.
let isTurn = false
let woke: string[] = [] // shells whose end arrived while no turn ran: the next turn is theirs
let turnOf: string[] = [] // the shells the running turn is charged to
let launchShare: Spent | undefined // the last response's share for each shell it launched
// the shells launched while a response still streams: the engine runs a call as soon as it is whole, before the
// response ends and its cost is known
let launchedInStep: string[] | undefined
const plus = (a: Spent | undefined, b: Spent): Spent => ({
  tokensIn: (a?.tokensIn ?? 0) + b.tokensIn,
  out: (a?.out ?? 0) + b.out,
  usd: (a?.usd ?? 0) + b.usd,
  steps: (a?.steps ?? 0) + b.steps,
})
const share = (s: Spent, n: number): Spent => ({ tokensIn: s.tokensIn / n, out: s.out / n, usd: s.usd / n, steps: s.steps / n })
// the shells a response is about: the turn's and the ones its tool calls name; and how many it launches. `jobs`: this
// chat's file jobs ("<id>@<started>"), about which a response is when its calls name the id as a word ("walk14" in
// walk14_train.log, not in walk14b)
export function chargesOf(uses: readonly { name: string; input: unknown }[], ids: Iterable<string>, turn: readonly string[], jobs: Iterable<string> = []) {
  const named = new Set(turn)
  const text = uses.map(u => JSON.stringify(u.input ?? ''))
  for (const id of ids) if (text.some(x => x.includes(id))) named.add(id)
  const isBg = (u: { name: string; input: unknown }) =>
    /^(Bash|PowerShell)$/.test(u.name) && (u.input as { run_in_background?: unknown } | null)?.run_in_background === true
  const isWord = (id: string) => {
    const re = new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`)
    return text.some(x => re.test(x))
  }
  const namedJobs = [...jobs].filter(k => isWord(k.slice(0, k.lastIndexOf('@'))))
  return { named: [...named], launches: uses.filter(isBg).length, jobs: namedJobs }
}
export const spentText = (s: Spent) => {
  const n = Math.round(s.steps)
  return `Claude on it: $${s.usd.toFixed(2)} · ${big(Math.round(s.tokensIn))} in · ${big(Math.round(s.out))} out · ${n} ${n === 1 ? 'response' : 'responses'}`
}

// The presence clock: seconds the person has spent at Claude (its window in front, input within IDLE_S), summed by one
// chat's watcher, a PowerShell child asking Windows every PRESENCE_EVERY_S, and kept in the store every chat shares
// (`presence`), so all of them read one clock; a chat that finds it stale starts its own watcher. undefined (another
// OS, no watcher yet): rows go by the wall clock.
type Presence = { activeS: number; at: number; by: string; here: boolean }
const PRESENCE_EVERY_S = 10
const PRESENCE_STALE_S = 30
const IDLE_S = 60
let activeNow: number | undefined
let isHere = false // the person at Claude at the last sample
let isWindows = false
let watchFailed = false // no sample ever came: the wall clock serves
let watchTried = 0
const PRESENCE_PS =
  `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DetalyIdle { ` +
  `[StructLayout(LayoutKind.Sequential)] public struct L { public uint Size; public uint Time; } ` +
  `[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l); [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow(); ` +
  `[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); ` +
  `public static string Now() { L l = new L(); l.Size = 8; GetLastInputInfo(ref l); uint idle = unchecked((uint)Environment.TickCount - l.Time) / 1000; ` +
  `uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); string n = ""; ` +
  `try { n = System.Diagnostics.Process.GetProcessById((int)p).ProcessName; } catch { } return idle + " " + n; } }'\n` +
  `while ($true) { [DetalyIdle]::Now(); Start-Sleep ${PRESENCE_EVERY_S} }\n`
// The watcher: "<idle s> <process in front>" a line; written to the store while no other chat's watcher is live.
// ponytail: a watcher that yields to another breaks its loop and leaves its child to the runtime; should it run on,
// it is an idle PowerShell (~70 MB) until the chat ends.
async function watch($: EngineInterface) {
  let samples = 0
  try {
    let rest = ''
    const argv = ['powershell', '-NoProfile', '-NonInteractive', '-Command', '-']
    for await (const { stream, text } of $.process.spawn({ argv, input: PRESENCE_PS })) {
      if (stream !== 'stdout') continue
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      const m = lines.map(l => /^(\d+) (\S*)/.exec(l.trim())).filter(x => x !== null).pop()
      if (!m) continue
      samples += 1
      const now = (await $.clock.now()) / 1000
      const p = (await $.store.get('presence').catch(() => undefined)) as Presence | undefined
      if (p && p.by !== selfId && now - p.at < PRESENCE_STALE_S) break
      const here = Number(m[1]) < IDLE_S && /^claude$/i.test(m[2] ?? '')
      const dt = p ? Math.max(0, Math.min(now - p.at, 2 * PRESENCE_EVERY_S)) : 0
      await $.store.set('presence', { activeS: (p?.activeS ?? 0) + (here ? dt : 0), at: now, by: selfId, here }).catch(() => {})
    }
  } catch {
    // no PowerShell, or it failed
  }
  if (!samples) watchFailed = true
}
// whether a row that ended at `endedAt` (wall s) after `ran` s, first seen at `seen` on the presence clock, still
// stays: unseen, for good while a presence clock can run (one between watchers too), else by the wall clock
const isKept = (now: number, endedAt: number, seen: number | undefined, ran: number) => {
  const keep = Math.min(KEEP_FINISHED_S, Math.max(15, ran))
  if (isWindows && !watchFailed) return seen === undefined || activeNow === undefined || activeNow - seen <= keep
  return now - endedAt <= keep
}

// A finished row's mark in the store (seen:<key> = { active, at }), read until it is there.
let sweptAt = 0 // when the store's marks were last swept
async function seenOf($: EngineInterface, key: string) {
  if (seenAt.has(key)) return
  const v = (await $.store.get(`seen:${key}`).catch(() => undefined)) as { active: number; at: number } | undefined
  if (v) seenAt.set(key, v.active)
}
async function forget($: EngineInterface, key: string) {
  seenAt.delete(key)
  marked.delete(key)
  await $.store.delete(`seen:${key}`).catch(() => {})
}
// The finished rows on the band's open page, drawn while the person is at Claude: seen, unless a chat saw them first.
async function markSeen($: EngineInterface, rows: (Row | undefined)[], nowS: number) {
  if (!isHere || activeNow === undefined || demo) return
  for (const r of rows) {
    if (!r?.seen || marked.has(r.seen)) continue
    marked.add(r.seen)
    if ((await $.store.get(`seen:${r.seen}`).catch(() => undefined)) === undefined)
      await $.store.set(`seen:${r.seen}`, { active: activeNow, at: nowS }).catch(() => {})
  }
}

// The row of a background task; undefined: drop the task, null: not yet shown
export function bgRowOf(id: string, t: Bg, now: number, output?: string): Row | null | undefined {
  const el = (t.endedAt ?? now) - t.started
  // a quick task never shows; a finished one stays as long as it ran, 15 s to 10 min of the person's time
  if (t.endedAt !== undefined && (el < SHOW_AFTER_S || !isKept(now, t.endedAt, seenAt.get(`bg-${id}`), el))) return undefined
  if (el < SHOW_AFTER_S && !t.isLate) return null
  const shown = `${t.isLate ? '≥ ' : ''}${clock(el)}`
  if (t.endedAt !== undefined) {
    const isOk = t.status === undefined || t.status === 'completed'
    const isStop = t.status === 'stopped' || t.status === 'killed'
    const tail = `${isOk ? 'done in' : `${isStop ? 'stopped' : t.status} after`} ${shown} · ${clockAt(now, t.endedAt - now)}` // and when
    const state = isOk ? 'done' : isStop ? 'stop' : 'fail'
    return { id: `bg-${id}`, title: t.title, f: isOk ? 1 : undefined, counts: '', tail, state, isTimer: !t.isCounted, seen: `bg-${id}` }
  }
  // an end in the description ("until ~21:35") is the clock to trust; a percent in the output may be a part of the job
  const p = output === undefined || t.isUntil ? undefined : progressOf(output)
  if (p) {
    t.isCounted = true
    // the average rate so far: the time the done share took, for the share left
    const tail = !t.isLate && p.f >= 0.02 && p.f < 1 && el >= 5 ? `~${leftAt(now, (el * (1 - p.f)) / p.f)}` : ''
    return { id: `bg-${id}`, title: t.title, f: p.f, counts: p.counts || shown, tail, state: 'run' }
  }
  // A timer row has one clock: counting down to its estimate, or up from its start without one. Minutes and 1/32
  // steps of the wait, so the row (and its pictures) change seldom rather than every tick.
  if (t.expectS && (!t.isLate || t.isUntil)) {
    const left = t.expectS - el
    const tail = left > 0 ? `${left < 60 ? '' : '~'}${leftAt(now, left, true)}` : `${coarse(-left)} over`
    return { id: `bg-${id}`, title: t.title, f: Math.min(31, Math.floor((el / t.expectS) * 32)) / 32, counts: '', tail, state: 'run', isTimer: true }
  }
  return { id: `bg-${id}`, title: t.title, f: undefined, counts: '', tail: `${t.isLate ? '≥ ' : ''}${coarse(el)}`, state: 'run', isTimer: true }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const isMine = (j: Job, session: string, root: string) =>
  j.session ? j.session === session : j.project ? (norm(j.project) + '/').startsWith(norm(root) + '/') : true

export function rowOf(id: string, j: Job, now: number): Row | undefined {
  const updated = j.updated ?? now
  const age = now - updated
  const seen = j.finished || j.stopped ? `${id}@${j.started}` : undefined
  if (seen && !isKept(now, updated, seenAt.get(seen), updated - (j.started ?? updated))) return undefined
  const done = j.done ?? 0
  const total = j.total ?? 0
  const unit = j.unit ? ` ${j.unit}` : ''
  const state: State = j.finished ? 'done' : j.stopped ? 'stop' : age > STALE_S ? 'stale' : 'run'
  const at = clockAt(now, updated - now) // when it ended: its last update
  let tail = state === 'done' ? `done · ${at}` : state === 'stop' ? `stopped · ${at}` : state === 'stale' ? `stalled ${dur(age)}` : ''
  if (state === 'run' && total > 0) {
    let eta = j.eta_s ?? undefined
    if (eta === undefined) {
      const key = `${id}@${j.started}`
      const seen = firstSeen.get(key) ?? { t: updated, done }
      firstSeen.set(key, seen)
      const rate =
        updated - seen.t >= 10 && done > seen.done
          ? (done - seen.done) / (updated - seen.t)
          : j.started && updated > j.started && done > 0
            ? done / (updated - j.started)
            : 0
      if (rate > 0) eta = (total - done) / rate
    }
    if (eta !== undefined) tail = leftAt(updated, eta)
  }
  // "Started 10:42 · running 1 h 12 min · 4.1 it/s": the rate is the run's average
  const ran = (state === 'run' || state === 'stale' ? now : updated) - (j.started ?? now)
  const rate = ran > 0 && done > 0 ? ` · ${perTime(done / ran, j.unit)}` : ''
  const info = j.started ? `Started ${clockAt(now, j.started - now)} · ${state === 'run' || state === 'stale' ? 'running' : 'ran'} ${dur(ran)}${rate}` : undefined
  return {
    id,
    title: j.title ?? id,
    f: total > 0 ? Math.min(1, Math.max(0, done / total)) : undefined,
    counts: total > 0 ? `${num(done)} / ${num(total)}${unit}` : `${num(done)}${unit}`,
    tail,
    state,
    info,
    ...(seen ? { seen } : {}),
  }
}
// "4.1 it/s", "16 it/min", "2.5/h"
const perTime = (perS: number, unit?: string) => {
  const [x, per] = perS >= 1 ? [perS, 's'] : perS * 60 >= 1 ? [perS * 60, 'min'] : [perS * 3600, 'h']
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)}${unit ? ` ${unit}` : ''}/${per}`
}

const tabAtom = atom({ plugin: 'detaly', key: 'tab' } as const, '')
const closedAtom = atom({ plugin: 'detaly', key: 'closed' } as const, [] as string[])
const miniAtom = atom({ plugin: 'detaly', key: 'mini' } as const, false)
// The band never grows past its room, so the engine never scrolls it: a desktop moved a taller band itself before
// the mod could answer, and the tabs shook (anthropics/claude-code#99449). The rows come in pages of the room, picked
// in a numbered column at the right (its own surface module, which takes the pointer); the wheel stays the chat's.
let page = 0 // the open page
let pageOf = '' // the tab it belongs to

// The ✖ on a row. This session's: a finished one leaves at once, a running one after "stop tracking? yes"; the job
// goes on, the band stops following it. Another session's row is hidden here only.
function dismiss($: EngineInterface, gid: string, id: string) {
  if (gid !== selfId) gone.add(`${gid}:${id}`)
  else if (id.startsWith('bg-')) {
    bg.delete(id.slice(3))
    gone.add(id)
    void save($)
  } else gone.add(`${id}@${lastGood.get(id)?.v.started}`)
  asking = undefined
  groups = groups.map(g => (g.id === gid ? { ...g, rows: g.rows.filter(r => r.id !== id) } : g))
  $.ui.invalidate('ui.render')
}
function ask($: EngineInterface, id: string | undefined) {
  asking = id
  $.ui.invalidate('ui.render')
}

// This chat's own sync: what it dismissed comes back, and the shells the last turn's end saw running that it does not
// follow (missed, or dismissed while still running) are followed again, start unknown. Its own dismissals are the keys
// with no ':' ("bg-<id>", "<file id>@<started>"); another chat's rows hidden here are "<chat>:<row>".
async function syncSelf($: EngineInterface) {
  for (const k of [...gone]) if (!k.includes(':')) gone.delete(k)
  await reconcile($)
  for (const t of bg.values()) if (t.endedAt === undefined) t.isCounted = undefined // its kind read again from its output
  await save($)
}

// A tab's sync. This chat: its own sync. Another chat: what was hidden here comes back, and that chat is asked to sync
// itself (a request file its mod reads on its next tick). All: both, for every chat, and closed tabs come back.
async function syncTab($: EngineInterface, id: string) {
  if (id === 'all' || id === selfId) await syncSelf($)
  for (const g of groups) {
    if (g.isSelf || (id !== 'all' && g.id !== id)) continue
    for (const k of [...gone]) if (k.startsWith(`${g.id}:`)) gone.delete(k)
    if (!g.id.startsWith('project:')) await $.store.set(`sync:${g.id}`, Date.now()).catch(() => {})
  }
  if (id === 'all') await update($, closedAtom, () => [])
  await runNow?.()
}

// A tab's ⟳ Refresh: its sync, then its finished rows leave (this chat's for good, another chat's here).
async function refreshTab($: EngineInterface, id: string) {
  await syncTab($, id)
  for (const g of groups) if (id === 'all' || g.id === id) for (const r of g.rows) if (isOver(r)) dismiss($, g.id, r.id)
}

// A small JSON file read again only when its mtime moved; one caught half-written keeps its last content.
async function fresh<T>($: EngineInterface, cache: Map<string, { mtime: number; v: T }>, key: string, path: string, mtime: number) {
  const was = cache.get(key)
  if (was?.mtime === mtime) return was.v
  const v = await $.fs.read(path).then(text => JSON.parse(text) as T).catch(() => undefined)
  if (v === undefined) return was?.v
  cache.set(key, { mtime, v })
  return v
}

async function tick($: EngineInterface, dir: string, root: string) {
  const now = (await $.clock.now()) / 1000
  // the presence clock, and a watcher of this chat's when none is live
  const pr = (await $.store.get('presence').catch(() => undefined)) as Presence | undefined
  activeNow = pr && now - pr.at < PRESENCE_STALE_S ? pr.activeS : undefined
  const wasHere = isHere
  isHere = activeNow !== undefined && pr?.here === true
  if (isHere && !wasHere) $.ui.invalidate('ui.render') // back at Claude: what the band shows now is seen
  if (activeNow === undefined && isWindows && !demo && now - watchTried > 60) {
    watchTried = now
    void watch($)
  }
  // file jobs (any session's or none)
  const files: { id: string; job: Job; row: Row }[] = []
  const listed = new Set<string>()
  for (const f of (await $.fs.list(dir).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name === 'demo.json' || now - f.mtimeMs / 1000 > KEEP_ENDED_S) continue
    const id = f.name.slice(0, -5)
    listed.add(id)
    const job = await fresh<Job>($, lastGood, id, `${dir}/${f.name}`, f.mtimeMs)
    if (!job) continue
    const isEnded = job.finished || job.stopped
    if (!isEnded && now - f.mtimeMs / 1000 > KEEP_S) continue
    if (isEnded) await seenOf($, `${id}@${job.started}`)
    const row = rowOf(id, job, now)
    if (row && !gone.has(`${id}@${job.started}`)) files.push({ id, job, row })
  }
  // the caches keep only what is still listed
  for (const id of lastGood.keys()) if (!listed.has(id)) lastGood.delete(id)

  for (const k of firstSeen.keys()) if (!listed.has(k.slice(0, k.lastIndexOf('@')))) firstSeen.delete(k)
  for (const id of lastLine.keys()) if (!bg.has(id)) lastLine.delete(id)
  // this session's background shells
  const own: Row[] = []
  let isChanged = false
  for (const [id, t] of bg) {
    let output: string | undefined
    if (t.endedAt === undefined && t.output) {
      // read again only when it grew, and a big one every BIG_EVERY_S at most
      const st = await $.fs.stat(t.output).catch(() => undefined)
      const was = lastLine.get(id)
      if (was && st && (st.size === was.size || (st.size > BIG_OUTPUT && now - was.at < BIG_EVERY_S))) output = was.line
      else if (st && st.size > 0 && st.size < OUTPUT_MAX) {
        const text = await $.fs.read(t.output).catch(() => undefined)
        if (text !== undefined) lastLine.set(id, { size: st.size, at: now, line: lastLineOf(text) })
        output = lastLine.get(id)?.line
      }
    }
    const wasCounted = t.isCounted
    if (t.endedAt !== undefined) await seenOf($, `bg-${id}`)
    const row = bgRowOf(id, t, now, output)
    isChanged ||= t.isCounted !== wasCounted || row === undefined
    if (row) own.push(t.spent ? { ...row, spent: spentText(t.spent) } : row)
    else if (row === undefined) {
      bg.delete(id)
      await forget($, `bg-${id}`)
    }
  }
  if (isChanged) await save($)
  // what Claude spent on this chat's file jobs; a job no longer listed is forgotten
  ownJobs = files.filter(f => isMine(f.job, selfId, root)).map(f => `${f.id}@${f.job.started}`)
  const jobSpent = await read($, jobSpentAtom)
  if (Object.keys(jobSpent).some(k => !listed.has(k.slice(0, k.lastIndexOf('@')))))
    await update($, jobSpentAtom, m => Object.fromEntries(Object.entries(m).filter(([k]) => listed.has(k.slice(0, k.lastIndexOf('@'))))))
  const jobs = Object.fromEntries(ownJobs.flatMap(k => (jobSpent[k] ? [[k, spentText(jobSpent[k])]] : [])))
  // published for the other sessions' All tab: when it changes, and as a heartbeat
  const text = JSON.stringify([own, jobs])
  if (text !== published || now - publishedAt > PUBLISH_S) {
    const pub: Published = { session: selfId, label, updated: now, rows: own, jobs }
    await $.store.set(`chat:${selfId}`, pub).catch(() => {})
    published = text
    publishedAt = now
  }
  const demoFile = (await $.fs.list(dir).catch(() => [])).find(f => f.name === 'demo.json')
  demo = demoFile ? await fresh<Demo>($, lastDemo, 'demo', `${dir}/demo.json`, demoFile.mtimeMs) : undefined
  // another chat's ⟳ Refresh on this chat's tab: a request newer than the one last seen (the first read only notes it)
  const asked = Number((await $.store.get(`sync:${selfId}`).catch(() => 0)) ?? 0)
  if (syncSeen !== undefined && asked !== syncSeen) await syncSelf($)
  syncSeen = asked
  // the groups: this session (its shells and its file jobs), each live session that publishes, the rest by project
  const self: Group = {
    id: selfId,
    label: demo?.label ?? label,
    isSelf: true,
    rows: demo ? [] : [...own],
  }
  const byId = new Map<string, Group>([[selfId, self]])
  // the other chats: the store's entries (a demo's made-up chats come from files, sessions/demo-*.json)
  const chats: [string, Published][] = []
  if (!demo) {
    const keys = await $.store.keys().catch(() => [] as string[])
    // once a minute: a file job's mark goes with its file, any mark a day old (its chat ended with the row on)
    if (now - sweptAt > 60) {
      sweptAt = now
      for (const k of keys.filter(k => k.startsWith('seen:'))) {
        const key = k.slice(5)
        const v = (await $.store.get(k).catch(() => undefined)) as { at?: number } | undefined
        const isGone = !key.startsWith('bg-') && !listed.has(key.slice(0, key.lastIndexOf('@')))
        if (isGone || now - (v?.at ?? now) > 86_400) await forget($, key)
      }
    }
    for (const k of keys.filter(k => k.startsWith('chat:')).sort()) {
      const sid = k.slice(5)
      const p = sid === selfId ? undefined : ((await $.store.get(k).catch(() => undefined)) as Published | undefined)
      if (!p) continue
      if (now - p.updated > FORGET_S) {
        await $.store.delete(k).catch(() => {})
        await $.store.delete(`sync:${sid}`).catch(() => {})
      } else if (now - p.updated <= ALIVE_S) chats.push([sid, p])
    }
  } else {
    for (const f of (await $.fs.list(`${dir}/sessions`).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const sid = f.name.slice(0, -5)
      if (!f.name.endsWith('.json') || !sid.startsWith('demo-') || now - f.mtimeMs / 1000 > ALIVE_S) continue
      const p = await fresh<Published>($, lastPub, sid, `${dir}/sessions/${f.name}`, f.mtimeMs)
      if (p) chats.push([sid, p])
    }
  }
  for (const [sid, p] of chats) {
    if (demo && sid === 'demo-self') {
      self.rows.push(...p.rows.map(r => (r.spent || isOver(r) ? r : { ...r, spent: spentText(demoSpent(r.id)) })))
      continue
    }
    byId.set(sid, { id: sid, label: p.label, rows: p.rows.filter(r => !gone.has(`${sid}:${r.id}`)) })
  }
  // a file job's spend: this chat's own, or what the chat that launched it publishes
  const theirs = Object.assign({}, ...chats.map(([, p]) => p.jobs ?? {})) as Record<string, string>
  for (const { id, job, row: bare } of files) {
    if (demo && !id.startsWith('demo-')) continue
    const spent = jobs[`${id}@${job.started}`] ?? theirs[`${id}@${job.started}`]
    const row = spent ? { ...bare, spent } : bare
    if (isMine(job, selfId, root)) {
      self.rows.push(row)
      continue
    }
    const gid = job.session ?? `project:${job.project ?? ''}`
    const name = job.session ? `chat ${job.session.slice(0, 8)}` : (job.project ?? '').split(/[\\/]/).filter(Boolean).pop() ?? 'jobs'
    if (!byId.has(gid)) byId.set(gid, { id: gid, label: name, rows: [] })
    if (!gone.has(`${gid}:${row.id}`)) byId.get(gid)?.rows.push(row)
  }
  // what still runs first: the band scrolls past its room, and the finished rows are the ones that can wait
  const next = [...byId.values()]
    .filter(g => g.isSelf || g.rows.length > 0)
    .map(g => ({ ...g, rows: [...g.rows].sort((a, b) => Number(isOver(a)) - Number(isOver(b))) }))
  // the session's figures for the minimized band's top row (free: no breakdown asked)
  const u = demo ? demoUsage(Math.floor(now / 60) * 60) : await $.session.usage().catch(() => undefined)
  const isNewUsage = JSON.stringify(u) !== JSON.stringify(usage)
  usage = u
  if (JSON.stringify(next) !== JSON.stringify(groups) || isNewUsage) {
    groups = next
    $.ui.invalidate('ui.render')
  }
}

// Demo mode, for screenshots: ~/.claude/progress/demo.json { scene, label } turns it on. Made-up figures, this chat
// named `label` with the rows of sessions/demo-self.json (none of its own), only the made-up chats and job files (named
// demo-*), and `scene` picks what shows: all, self, mini, info
// (pinned), tools (the open tab's), name (the first cut name's card), spent (the first row's). No file: off.
type Demo = { scene?: string; label?: string }
let demo: Demo | undefined
const lastDemo = new Map<string, { mtime: number; v: Demo }>()
const demoUsage = (now: number): SessionUsage => ({
  startedAt: (now - 7_200) * 1000,
  context: { tokens: 46_000, window: 200_000, percent: 23 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 41, resetsAt: new Date((now + 6_300) * 1000).toISOString() },
    { kind: 'seven_day', percentUsed: 73, resetsAt: new Date((now + 280_000) * 1000).toISOString() },
  ],
  cost: { usd: 3.32 },
})
const demoTokens = (now: number) => ({ since: (now - 7_200) * 1000, in: 1_987_000, cacheRead: 1_700_000, cacheWrite: 120_000, out: 19_870 })
// a row's made-up spend, the same for the same row
const demoSpent = (id: string): Spent => {
  const k = [...id].reduce((n, c) => n + c.charCodeAt(0), 0)
  return { tokensIn: 120_000 + (k % 7) * 61_000, out: 900 + (k % 5) * 700, usd: 0.08 + (k % 9) * 0.07, steps: 1 + (k % 4) }
}

// The session's figures: the minimized band's top row and the tabs' ⓘ Info card. Context, rate limits (a ring
// filled to the share used: blue, amber from 70 %, red from 90 %), tokens, cost; the details in a card.
let usage: SessionUsage | undefined
let isInfoPinned = false // ⓘ Info pressed: its card stays open
const LEVEL = [
  [90, '#E5534B', 'error'],
  [70, '#E0A030', 'warning'],
  [0, '#4A8FE7', 'suggestion'],
] as const
const levelOf = (pct: number) => LEVEL.find(([from]) => pct >= from) ?? LEVEL[2]
const tokensAtom = atom({ plugin: 'detaly', key: 'tokens' } as const, { since: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 })
const jobSpentAtom = atom({ plugin: 'detaly', key: 'jobSpent' } as const, {} as Record<string, Spent>)
let ownJobs: string[] = [] // this chat's file jobs, "<id>@<started>", as the last tick listed them
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const LIMIT = { five_hour: ['5h', '5-hour limit'], seven_day: ['week', 'Weekly limit'], spend_limit: ['spend', 'Spend limit'] } as const
type Stat = { text: string; f?: number }
function statsOf(now: number, t: { since: number; in: number; cacheRead: number; cacheWrite: number; out: number }) {
  const line: Stat[] = []
  const card: string[] = []
  const ctx = usage?.context
  if (ctx?.percent !== undefined) {
    line.push({ text: `ctx ${ctx.percent}%` })
    card.push(`Context ${big(ctx.tokens ?? 0)} of ${big(ctx.window)} tokens (${ctx.percent} %)`)
  }
  for (const r of usage?.rateLimits ?? []) {
    const [short, long] = LIMIT[r.kind as keyof typeof LIMIT] ?? [r.kind, r.kind]
    line.push({ text: `${short} ${r.percentUsed}%`, f: r.percentUsed / 100 })
    const at = r.resetsAt ? Date.parse(r.resetsAt) / 1000 : NaN
    card.push(`${long} ${r.percentUsed} %${Number.isNaN(at) ? '' : ` · resets ${clockAt(now, at - now)}`}`)
  }
  const input = t.in + t.cacheRead + t.cacheWrite
  if (input + t.out > 0) {
    line.push({ text: `${big(input)} in · ${big(t.out)} out` })
    card.push(`Tokens since ${clockAt(now, t.since / 1000 - now)}: in ${big(input)} (cache read ${big(t.cacheRead)}, written ${big(t.cacheWrite)}) · out ${big(t.out)}`)
  }
  if (usage?.cost) {
    line.push({ text: `$${usage.cost.usd.toFixed(2)}` })
    card.push(`Cost $${usage.cost.usd.toFixed(2)} · session ${coarse(now - usage.startedAt / 1000)}`)
  }
  return { line, card }
}

async function closeTab($: EngineInterface, id: string, isActive: boolean) {
  await update($, closedAtom, c => [...c, id])
  if (isActive) await update($, tabAtom, () => '')
}

// "<folder> · <start of the first message>", the folder alone before one
const labelOf = (dirName: string, text: string) => {
  const t = promptOf(text).replace(/\s+/g, ' ').slice(0, 40)
  return t ? `${dirName} · ${t}` : dirName
}
// A user row's own words: tagged blocks (reminders, command echoes) cut whole; the rows the engine itself puts in a
// transcript (worktree notes, caveats, continuations) count as none.
const promptOf = (text: string) => {
  const t = text
    .replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .trim()
  return /^(You are operating in a git worktree|Caveat:|\[SYSTEM|This session is being continued)/.test(t) ? '' : t
}

// Theme keys for the text, the same hues as hex for the desktop's SVG bar (an image: no theme there).
const COLOR = { run: 'claude', stale: 'warning', done: 'success', fail: 'error', stop: 'inactive' } as const
const HEX = { run: '#D97757', stale: '#E0A030', done: '#4EBA65', fail: '#E5534B', stop: '#999999' } as const
const ICON = { run: '●', stale: '◌', done: '✓', fail: '✕', stop: '■' } as const
// ponytail: the desktop draws cells ~7.85 px wide (measured on Windows 11 at 100 % zoom); an SVG is sized in px, so
// a bar that fills its column is cells * this. Another zoom leaves the bar a little short or long of its column.
const CELL_PX = 7.85
const ICON_W = 3 // the icon cell, in cells: room for a desktop's native button when the × replaces the icon
// ponytail: a desktop draws a name in a proportional bold face, so whether it is cut is a guess at its width by letter
// class (fitted to names seen cut or whole in a 17-cell column); a wrong guess shows the whole-name card on a name that
// fits, or none on one cut by a letter. The terminal counts cells.
const namePx = (t: string) =>
  [...t].reduce((n, c) => n + (/[iljtfrI.,:;'|!()\s]/.test(c) ? 3.9 : /[mwMW]/.test(c) ? 11.1 : /[A-Z]/.test(c) ? 8.5 : 7), 0)

const BAR_H = 20 // a bar's height in px: its numbers inside, in a row two lines tall
const THIN_H = 12 // a thin bar's, in a row one line tall (~19 px)
const PAGE_JOBS = 10 // job rows on a page at most
const TRACK = '#4d4d4d' // solid, so white numbers read on it in a dark and a light theme alike
// a hover card: a desktop draws a placed Box with no ground of its own, so the rows under it showed through
const CARD_BG = '#2a2a2a'
const CARD_TEXT = '#ececec'
const CARD_EDGE = '#3a3a3a' // a soft light rounded edge, as a desktop's own popovers have
const padOf = (h: number) => (h >= BAR_H ? 4 : 2) // px of air above and below a bar, so the rows do not touch

// w, h: the bar's size in px; the picture is h + 2 padOf(h) tall
const bar = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 2 * padOf(h)}" viewBox="0 ${-padOf(h)} ${w} ${h + 2 * padOf(h)}">${body}</svg>`
const pill = (w: number, h: number, fill = TRACK, more = '') => `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"${more}/>`
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A counted bar with its numbers inside, centred: light on the track, black where the fill runs under them. Segoe UI
// (the image sees system fonts only; the variable face drops the weight there), bold, tabular figures so the numbers
// do not jitter as they count. The baseline is set by hand: dominant-baseline is drawn low in an image.
const svgCounted = (w: number, h: number, f: number, state: State, pct: string, counts: string) => {
  const fw = f > 0 ? Math.max(h, Math.round(f * w)) : 0
  const text = (color: string, soft: number) =>
    barText(w, h, color, `<tspan font-weight="700">${esc(pct)}</tspan>` + (counts ? `<tspan dx="10" font-weight="600" fill-opacity="${soft}">${esc(counts)}</tspan>` : ''))
  return bar(w, h, pill(w, h) + pill(fw, h, HEX[state]) + split(w, h, fw, text('#ececec', 0.65), text('#141414', 0.9)))
}
// text centred in a bar
const barText = (w: number, h: number, color: string, spans: string) =>
  `<text x="${w / 2}" y="${h / 2 + (h >= BAR_H ? 4.3 : 3.4)}" text-anchor="middle" fill="${color}" ` +
  `font-family="'Segoe UI',system-ui,sans-serif" font-size="${h >= BAR_H ? 12 : 9.5}" style="font-variant-numeric:tabular-nums">${spans}</text>`
// each colour only where its ground is: the light text off the fill (fw px), the dark one on it (drawn over each
// other, the light one's anti-aliased edges ringed the dark one in white)
const split = (w: number, h: number, fw: number, light: string, dark: string) => {
  const r = h / 2
  const fill = fw > 0 ? `M${r} 0H${fw - r}A${r} ${r} 0 0 1 ${fw - r} ${h}H${r}A${r} ${r} 0 0 1 ${r} 0Z` : ''
  return (
    `<defs><clipPath id="f"><path d="${fill}"/></clipPath>` +
    `<clipPath id="t"><path clip-rule="evenodd" d="M0 0H${w}V${h}H0Z${fill}"/></clipPath></defs>` +
    `<g clip-path="url(#t)">${light}</g>` +
    (fw > 0 ? `<g clip-path="url(#f)">${dark}</g>` : '')
  )
}

// An animation's start in the past, so it runs on the wall clock: a desktop draws each Svg as a new image whenever the
// band is drawn again (every tick while a job counts), and an image's animation starts from its beginning; begun
// `t mod dur` ago, the new image picks up where the old one was.
const since = (t: number, dur: number) => `begin="-${(t % dur).toFixed(2)}s"`

// A timer's bar, animated so a wait does not look stalled (SMIL in a plain image: no frame to reload and flash):
// filled to f with stripes running through it, or without f a soft segment sweeping the track; "waiting" inside, so
// it does not read as work counted. t: now, unix s.
const svgWait = (w: number, h: number, f: number | undefined, t: number) => {
  const c = HEX.run
  const body =
    f === undefined
      ? `<defs><linearGradient id="g"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="0.5" stop-color="${c}"/>` +
        `<stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>${pill(w, h)}` +
        `<rect width="80" height="${h}" fill="url(#g)"><animate attributeName="x" values="-80;${w};-80" dur="${(3 * w) / 160}s" ${since(t, (3 * w) / 160)} repeatCount="indefinite"/></rect>`
      : `<defs><pattern id="s" width="${h}" height="${h}" patternUnits="userSpaceOnUse">` +
        `<path d="M0 ${h}L${h / 2} 0H${h}L${h / 2} ${h}Z" fill="#fff" fill-opacity="0.2"/>` +
        `<animateTransform attributeName="patternTransform" type="translate" from="0 0" to="${h} 0" dur="1s" ${since(t, 1)} repeatCount="indefinite"/></pattern></defs>` +
        pill(w, h) +
        pill(Math.max(h, Math.round(f * w)), h, c, ' fill-opacity="0.85"') +
        pill(Math.max(h, Math.round(f * w)), h, 'url(#s)')
  const label = (color: string, soft: number) =>
    barText(w, h, color, `<tspan font-weight="600" fill-opacity="${soft}">${f === undefined ? 'waiting · no estimate' : 'waiting'}</tspan>`)
  const fw = f === undefined ? 0 : Math.max(h, Math.round(f * w))
  return bar(w, h, `<clipPath id="r">${pill(w, h)}</clipPath><g clip-path="url(#r)">${body}</g>` + split(w, h, fw, label('#ececec', 0.7), label('#141414', 0.9)))
}

// A timer's ring: filled clockwise to f, or an arc spinning without f (SMIL).
const RING = 2 * Math.PI * 5.5
const svgRing = (f: number | undefined, hex: string, t = 0) => {
  const arc = `cx="7" cy="7" r="5.5" fill="none" stroke-width="2"`
  const fill =
    f === undefined
      ? `<circle ${arc} stroke="${hex}" stroke-linecap="round" stroke-dasharray="9 ${RING}">` +
        `<animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="1s" ${since(t, 1)} repeatCount="indefinite"/></circle>`
      : `<circle ${arc} stroke="${hex}" stroke-dasharray="${(f * RING).toFixed(1)} ${RING}" transform="rotate(-90 7 7)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle ${arc} stroke="#888" stroke-opacity="0.35"/>${fill}</svg>`
}

export const register: Register = on => {
  // a chat that ends takes its entry out of the store (the others would forget it after FORGET_S anyway)
  on('session.end', async ($, e, next) => {
    await $.store.delete(`chat:${selfId}`).catch(() => {})
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const dir = `${home}/.claude/progress`
    progressDir = dir
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    selfId = await $.session.id()
    // a worktree session belongs to its repository: <repo>/.claude/worktrees/<name>
    const root = (await $.session.root()).replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, '')
    folder = root.split(/[\\/]/).filter(Boolean).pop() ?? 'chat'
    const first = (await $.session.messages().catch(() => [])).find(m => m.role === 'user' && promptOf(m.text))
    label = labelOf(folder, first?.text ?? '')
    await $.env.set('CLAUDE_JOB_SESSION', selfId) // the helpers tag what this session launches
    for (const [id, t] of await read($, tasks)) bg.set(id, t) // what ran before this load of the mod
    await reconcile($) // and what started or ended while it was away
    await $.command.register({ name: 'detaly', description: "Detaly: open the band on the All tab (every chat's jobs)" })
    let isBusy = false
    const run = async () => {
      if (isBusy) return
      isBusy = true
      try {
        await tick($, dir, root)
      } finally {
        isBusy = false
      }
    }
    runNow = run
    $.clock.every(TICK_MS, run)
    void run()

    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const ran = await next(e)
    if (e.run_in_background) {
      const id = launched((await $.clock.now()) / 1000, e.description, e.command, ran.text)
      const t = id ? bg.get(id) : undefined
      if (id && launchedInStep) launchedInStep.push(id)
      else if (t && launchShare) t.spent = plus(t.spent, launchShare)
      await save($)
    }
    return ran
  })

  // A stopped shell sends no notification: its end is the stop.
  on('tool.call', { tool: ['TaskStop', 'KillShell'] }, async ($, e, next) => {
    const ran = await next(e)
    const t = bg.get(String((e as { task_id?: unknown; shell_id?: unknown }).task_id ?? (e as { shell_id?: unknown }).shell_id))
    if (t && t.endedAt === undefined && !('deny' in ran) && !ran.isError) {
      Object.assign(t, { endedAt: (await $.clock.now()) / 1000, status: 'stopped' })
      await save($)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawnAt = (await $.clock.now()) / 1000 // the animations' phase
    if (e.props.hasSurvey) return next(e)
    const stored = await read($, tabAtom)
    const closed = await read($, closedAtom)
    const scene = demo?.scene
    const isMini = scene ? scene === 'mini' : await read($, miniAtom)
    const tabs = groups.filter(g => g.isSelf || !closed.includes(g.id))
    const self = tabs.find(g => g.isSelf)
    const active = scene
      ? ['all', 'info', 'tools'].includes(scene) ? 'all' : selfId
      : !isMini && (stored === 'all' || tabs.some(g => g.id === stored && !g.isSelf)) ? stored : selfId
    // with no jobs anywhere the band stays a strip: the tab row (All, this chat, ⓘ Info, ▾ Minimize), or minimized the
    // session's figures, ⟳ Refresh and ▴ Tabs
    const shown = active === 'all' ? tabs.filter(g => g.rows.length > 0) : tabs.filter(g => g.id === active)
    const all = shown.flatMap(g => g.rows)
    const shownSpent = all.find(r => r.spent)?.id
    // A card shown for good, or revealed while its keyed Box is hovered (the engine refuses a hover that reveals a card
    // already shown).
    const shownOr = (isShown: boolean) => (isShown ? { display: 'flex' as const } : { display: 'none' as const, hover: { display: 'flex' as const } })
    let shownCut: string | undefined // set once the name column's width is known
    // A card the desktop lifts out of the band while its keyed Box is hovered (scope-less, hidden, placed): drawn in the
    // band it was cut at the band's edge (the band clips); lifted, it sits above the Box (under it without room there)
    // in the desktop's own card, theme colours, its place and box props dropped. A terminal draws it in place.
    const lifted = { position: 'absolute' as const, top: 1, left: 0, flexDirection: 'column' as const, paddingX: 1, borderStyle: 'round', ...shownOr(false) }

    const { Box, Text, Button } = $.ui.resolve(e)
    const ui = $.ui.resolve(e)
    const Client = 'Client' in ui ? ui.Client : undefined // the pages' column, a surface module (desktop, terminal)
    // by the surface: the element table answers any name ('Svg' in it is true on the terminal too)
    const Svg = e.surface === 'desktop' || e.surface === 'mobile' ? $.ui.resolve(e).Svg : undefined
    // Columns: icon, name (under a fifth of the band; one line, the whole on hover), bar (the rest; a counted row's
    // numbers inside it), time (right-aligned, as wide as its longest text, 12 to 28). Every row is two lines tall, or one
    // when they overflow (below).
    const tailW = Math.max(12, Math.min(28, Math.max(0, ...all.map(r => r.tail.length))))
    const nameW = Math.max(12, Math.min(22, Math.floor(e.props.bodyColumns * 0.18)))
    const isCut = (t: string) => (Svg ? namePx(t) > nameW * CELL_PX : t.length > nameW)
    shownCut = all.find(r => isCut(r.title))?.id
    // The header (the tab row and its gap; minimized, ▴ Tabs) and the items under it: as tall as they are, up to the
    // band's rows (and half the screen) less one: a desktop's rows run a few pixels taller than the engine counts
    // (the tabs' native buttons), and a band past its room in pixels scrolls under the wheel. Past the room, pages,
    // their numbers at the right (three cells off the bar). Every row has an explicit height: a desktop counts a margin
    // in cells across (~8 px), not rows (~19 px).
    const head = isMini ? 1 : 2
    const half = e.viewport?.rows ? Math.floor(e.viewport.rows / 2) : 99
    const room = Math.max(2, Math.min(e.props.maxRows || 99, half) - head - 1)
    // A job row is two lines tall, one (a thin bar) when the two-line rows overflow the room. Pages hold at most
    // PAGE_JOBS rows and the room's lines; a page that opens inside a chat's rows repeats its heading (in All), and a
    // heading never ends a page.
    const isAll = active === 'all'
    const thin = shown.reduce((n, g) => n + 2 * g.rows.length + (isAll ? 1 : 0), 0) > room
    const rowH = thin ? 1 : 2
    type Slot = { g: Group; r?: Row } // a chat's heading (no r) or one of its rows
    const pages: Slot[][] = []
    let cur: Slot[] = []
    let used = 0
    let jobs = 0
    for (const g of shown) {
      g.rows.forEach((r, i) => {
        const lead = isAll && (i === 0 || !cur.length) ? 1 : 0 // a heading before a chat's first row, atop a page
        if (cur.length && (used + lead + rowH > room || jobs === PAGE_JOBS)) {
          pages.push(cur)
          cur = []
          used = 0
          jobs = 0
        }
        if (isAll && (i === 0 || !cur.length)) {
          cur.push({ g })
          used += 1
        }
        cur.push({ g, r })
        used += rowH
        jobs++
      })
    }
    if (cur.length) pages.push(cur)
    const hasMore = pages.length > 1
    const barW = Math.max(16, e.props.bodyColumns - ICON_W - nameW - tailW - 2 * 3 - (hasMore ? 3 : 0))
    const px = Math.floor(barW * CELL_PX) - 2
    const icon = (r: Row) => {
      if (!r.isTimer || r.state !== 'run') return <Text color={COLOR[r.state]}>{ICON[r.state]}</Text>
      if (Svg) {
        const alt = r.f === undefined ? 'running' : `${Math.floor(r.f * 100)} %`
        return <Svg source={svgRing(r.f, HEX[r.state], drawnAt)} alt={alt} width={14} height={14} />
      }
      const glyph = r.f === undefined ? '◌' : '○◔◑◕●'[Math.min(4, Math.round(r.f * 4))]
      return <Text color={COLOR[r.state]}>{glyph}</Text>
    }
    // The bar: a running timer's animated wait, or a counted bar with its percent and counts inside it.
    const middle = (r: Row) => {
      const barH = thin ? THIN_H : BAR_H // not 'h': that is the JSX factory
      if (r.isTimer && r.state === 'run') {
        const alt = r.f === undefined ? 'waiting' : `${Math.floor(r.f * 100)} % of the wait`
        if (Svg) return <Svg source={svgWait(px, barH, r.f, drawnAt)} alt={alt} width={px} height={barH + 2 * padOf(barH)} />
        if (r.f !== undefined) return <Text color={COLOR.run} dimColor>{'━'.repeat(Math.floor(r.f * barW)).padEnd(barW, '─')}</Text>
        return <Text color="subtle">{'┄'.repeat(barW)}</Text>
      }
      const f = r.f
      if (f === undefined) return <Text>{''}</Text>
      const pct = `${Math.floor(f * 100)} %`
      const counts = r.isTimer ? '' : r.counts
      if (Svg) {
        const label = r.isTimer ? '' : pct // a finished timer: a plain full bar
        return <Svg source={svgCounted(px, barH, f, r.state, label, counts)} alt={[pct, counts].filter(Boolean).join('  ')} width={px} height={barH + 2 * padOf(barH)} />
      }
      const textW = r.isTimer ? 0 : pct.length + (counts ? counts.length + 2 : 0) + 2 // a space each side
      const label = (
        <Box width={textW} justifyContent="center">
          <Text>
            <Text bold dimColor={r.state === 'done'}>{pct}</Text>
            <Text dimColor>{counts ? `  ${counts}` : ''}</Text>
          </Text>
        </Box>
      )
      const n = Math.floor(f * barW)
      const leftW = Math.max(0, Math.floor((barW - textW) / 2))
      const line = (from: number, len: number) => {
        const k = Math.min(len, Math.max(0, n - from))
        return (
          <Text>
            <Text color={COLOR[r.state]}>{'━'.repeat(k)}</Text>
            <Text color="subtle">{'─'.repeat(len - k)}</Text>
          </Text>
        )
      }
      return (
        <Box flexDirection="row">
          {line(0, leftW)}
          {textW ? label : null}
          {line(leftW + textW, Math.max(0, barW - leftW - textW))}
        </Box>
      )
    }
    // this chat's rows keep their own ids as keys; another chat's are prefixed with it
    const keyOf = (g: Group, r: Row) => (g.isSelf ? r.id : `${g.id}:${r.id}`)
    const rowView = (g: Group, r: Row) => (
      <Box key={keyOf(g, r)} flexDirection="row" alignItems="center" gap={2} height={rowH}>
        {/* hovered (the row's Box is the scope), a ✖ takes the icon's place: the cell clips, and the hidden ✖
            before the icon, as wide as the cell, is revealed and pushes the icon out past the edge. This chat's
            finished row leaves at once, its running one after "stop tracking?"; another chat's is hidden here. */}
        <Box width={ICON_W} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
          <Box width={ICON_W} flexShrink={0} justifyContent="center" display="none" hover={{ display: 'flex' }}>
            {/* a desktop draws its own button, child colours ignored: the label's colour goes through hover */}
            <Button
              key={`x-${keyOf(g, r)}`}
              plain
              label="✖"
              hover={{ color: 'error', bold: true }}
              onPress={() => (g.isSelf && !isOver(r) ? ask($, r.id) : dismiss($, g.id, r.id))}
            />
          </Box>
          <Box width={ICON_W} flexShrink={0} alignItems="center" justifyContent="center">
            {icon(r)}
          </Box>
        </Box>
        {/* hovered, a cut name shows whole, and the bar the job's run and spend, in cards the desktop lifts above them
            (the band clips what it draws) */}
        <Box key={`n-${keyOf(g, r)}`} width={nameW} alignItems="center">
          <Text bold dimColor={r.state === 'done'} wrap="truncate-end">
            {r.title}
          </Text>
          {isCut(r.title) && !(scene === 'name' && r.id === shownCut) ? (
            <Box {...lifted}>
              <Text bold>{r.title}</Text>
            </Box>
          ) : null}
        </Box>
        <Box key={`b-${keyOf(g, r)}`} width={barW}>
          {g.isSelf && asking === r.id ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text>Stop tracking this job? It keeps running.</Text>
              <Button key={`yes-${r.id}`} variant="primary" onPress={() => dismiss($, g.id, r.id)}>
                Yes
              </Button>
              <Button key={`no-${r.id}`} onPress={() => ask($, undefined)}>
                No
              </Button>
            </Box>
          ) : (
            middle(r)
          )}
          {(r.spent || r.info) && !(g.isSelf && asking === r.id) && !(scene === 'spent' && r.id === shownSpent) ? (
            <Box {...lifted}>
              {[r.info, r.spent].filter(Boolean).map(l => <Text key={l}>{l}</Text>)}
            </Box>
          ) : null}
        </Box>
        <Box width={tailW} justifyContent="flex-end">
          <Text color={r.state === 'run' ? undefined : COLOR[r.state]} dimColor={r.state === 'run'} wrap="truncate-end">
            {r.tail}
          </Text>
        </Box>
      </Box>
    )
    // A demo scene's card shown for good (the whole name, what Claude spent), drawn last in the band at the row's place,
    // so nothing drawn after paints over it.
    const rowCards = (r: Row, top: number) => [
      isCut(r.title) && scene === 'name' && r.id === shownCut ? (
        <Box position="absolute" top={top} left={ICON_W + 2} width={Math.ceil((1.25 * namePx(r.title)) / CELL_PX) + 2} paddingX={1} backgroundColor={CARD_BG} borderStyle="round" borderColor={CARD_EDGE}>
          <Text bold color={CARD_TEXT}>
            {r.title}
          </Text>
        </Box>
      ) : null,
      r.spent && scene === 'spent' && r.id === shownSpent ? (
        <Box position="absolute" top={top} right={hasMore ? 3 : 0} width={r.spent.length + 2} paddingX={1} backgroundColor={CARD_BG} borderStyle="round" borderColor={CARD_EDGE}>
          <Text color={CARD_TEXT}>{r.spent}</Text>
        </Box>
      ) : null,
    ]
    // the open page's rows
    if (pageOf !== active) page = 0
    pageOf = active
    page = Math.min(page, Math.max(0, pages.length - 1))
    type Item = { rows: number; view: ReturnType<typeof rowView> }
    const list: Item[] = (pages[page] ?? []).map(({ g, r }) =>
      r
        ? { rows: rowH, view: rowView(g, r) }
        : { rows: 1, view: <Box key={`head-${g.id}`} height={1}><Text bold dimColor>{g.label}</Text></Box> },
    )
    void markSeen($, (pages[page] ?? []).map(sl => sl.r), (await $.clock.now()) / 1000)
    const cards: ReturnType<typeof rowCards> = []
    let rowTop = head
    for (const { g, r } of pages[page] ?? []) {
      if (r) cards.push(...rowCards(r, rowTop))
      rowTop += r ? rowH : 1
    }
    if (active === 'all' && all.length === 0)
      list.push({ rows: 1, view: <Box key="none" height={1}><Text dimColor>No jobs in any chat.</Text></Box> })
    // All, and any tab with pages, keeps one height whatever page is open
    const shownRows = list.reduce((n, it) => n + it.rows, 0)
    if ((pages.length > 1 || active === 'all') && shownRows < room) list.push({ rows: room - shownRows, view: <Box key="pad" height={room - shownRows} /> })
    const pager =
      pages.length > 1 && Client ? (
        <Box position="absolute" top={head} right={0} width={3} height={room}>
          <Client key="pager" module="./pager.tsx" props={{ page, pages: pages.length, rows: room }} width={3} height={room} />
        </Box>
      ) : null

    // Minimized: this chat's rows alone, the session's figures over them, ⟳ Refresh (this chat's); ▴ Tabs, where
    // ▾ Minimize was, brings the tabs back.
    // The figures in a row, a limit with its ring; the details in a card under it.
    const nowS = (await $.clock.now()) / 1000
    const stats = statsOf(nowS, demo ? demoTokens(nowS) : await read($, tokensAtom))
    const figures = (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} overflow="hidden">
        {stats.line.map((st, i) => {
          const [, hex, theme] = levelOf((st.f ?? 0) * 100)
          return (
            <Box key={`stat-${i}`} flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
              {i ? <Text dimColor>·</Text> : null}
              {st.f === undefined ? null : Svg ? (
                <Svg source={svgRing(Math.min(1, Math.max(0.02, st.f)), hex)} alt={st.text} width={14} height={14} />
              ) : (
                <Text color={theme}>{'○◔◑◕●'[Math.min(4, Math.round(st.f * 4))]}</Text>
              )}
              <Text dimColor>{st.text}</Text>
            </Box>
          )
        })}
      </Box>
    )
    const details = (color?: string) => stats.card.map(l => (
      <Text key={l} color={color}>
        {l}
      </Text>
    ))

    if (isMini) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" height={1} gap={2}>
            <Box key="stat-figures" flexGrow={1} flexShrink={1}>
              {figures}
              {stats.card.length ? <Box {...lifted}>{details()}</Box> : null}
            </Box>
            <Button key="refresh-mini" plain label="⟳ Refresh" onPress={() => refreshTab($, selfId)} />
            <Button key="expand" plain label="▴ Tabs" onPress={() => update($, miniAtom, () => false)} />
          </Box>
          {list.map(it => it.view)}
          {pager}
          {cards}
        </Box>
      )
    }

    // The tab row, as a browser's: All, this chat, the other chats with jobs; the open tab is the primary button.
    // Hovered, a tab shows its tools in a card under it, in the row between the tabs and the bars: ⟳ Refresh (its sync,
    // and its finished rows leave), and on another chat's tab ✖ Close (All's Refresh brings closed tabs back).
    const short = (t: string) => (t.length > 24 ? `${t.slice(0, 23)}…` : t)
    const running = (g: Group) => g.rows.filter(r => !isOver(r)).length
    const tab = (id: string, text: string, count: number, isClosable: boolean) => (
      <Box key={`tab-${id}`} flexDirection="row" alignItems="center">
        <Button key={`tab:${id}`} variant={id === active ? 'primary' : undefined} onPress={() => update($, tabAtom, () => id)}>
          {text}
          <Text dimColor>{count ? ` ${count}` : ''}</Text>
        </Button>
        <Box position="absolute" top={1} left={0} flexDirection="row" gap={1} paddingX={1} backgroundColor={CARD_BG} borderStyle="round" borderColor={CARD_EDGE} {...shownOr(scene === 'tools' && id === active)}>
          <Button key={`refresh:${id}`} plain label="⟳ Refresh" onPress={() => refreshTab($, id)} />
          {isClosable ? (
            <Button key={`close:${id}`} plain label="✖ Close" hover={{ color: 'error', bold: true }} onPress={() => closeTab($, id, id === active)} />
          ) : null}
        </Box>
      </Box>
    )
    const others = tabs.filter(g => !g.isSelf)

    return (
      <Box flexDirection="column">
        <Box height={2} flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1} height={1}>
            {tab('all', 'All', tabs.reduce((n, g) => n + running(g), 0), false)}
            {self ? tab(selfId, short(self.label), running(self), false) : null}
            {others.map(g => tab(g.id, short(g.label), running(g), true))}
            <Box flexGrow={1} />
            {/* ⓘ Info: the minimized row's figures and details in a card, while hovered or once pressed */}
            <Box key="info" flexDirection="row">
              <Button
                key="info-btn"
                plain
                label="ⓘ Info"
                onPress={() => {
                  isInfoPinned = !isInfoPinned
                  $.ui.invalidate('ui.render')
                }}
              />
              {isInfoPinned || scene === 'info' ? null : (
                <Box {...lifted}>
                  {figures}
                  {details()}
                </Box>
              )}
            </Box>
            <Button key="mini" plain label="▾ Minimize" onPress={() => update($, miniAtom, () => true)} />
          </Box>
        </Box>
        {list.map(it => it.view)}
        {pager}
        {cards}
        {isInfoPinned || scene === 'info' ? (
          <Box position="absolute" top={1} right={0} display="flex" flexDirection="column" paddingX={1} backgroundColor={CARD_BG} borderStyle="round" borderColor={CARD_EDGE}>
            {figures}
            {details(CARD_TEXT)}
          </Box>
        ) : null}
      </Box>
    )
  })

  // a page picked in the numbered column
  on('ui.message', { element: 'pager' }, ($, e) => {
    const to = (e.data as { page?: unknown } | null)?.page
    if (typeof to === 'number' && to !== page) {
      page = Math.max(0, Math.round(to))
      $.ui.invalidate('ui.render')
    }
    return {}
  })

  // a turn opened while shells' ends waited is theirs
  on('turn.start', ($, e, next) => {
    isTurn = true
    turnOf = woke
    woke = []
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    isTurn = false
    turnOf = []
    return next(e)
  })

  // Every model response's tokens, summed for the session (subagents' too): the API's usage, as it reports it.
  on('turn.step', async function* ($, e, next) {
    const before = (await $.session.usage().catch(() => undefined))?.cost?.usd
    const mine: string[] = []
    if (!e.agentId) launchedInStep = mine
    let r
    try {
      r = yield* next(e)
    } finally {
      if (launchedInStep === mine) launchedInStep = undefined
    }
    const u = r?.usage
    if (u && r) {
      const after = (await $.session.usage().catch(() => undefined))?.cost?.usd
      const s: Spent = {
        tokensIn: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        out: u.output_tokens,
        usd: before !== undefined && after !== undefined ? Math.max(0, after - before) : 0,
        steps: 1,
      }
      const { named, launches, jobs } = chargesOf(r.toolUses, bg.keys(), turnOf, ownJobs)
      const n = named.length + launches + jobs.length
      const each = n ? share(s, n) : undefined
      if (each && jobs.length)
        await update($, jobSpentAtom, m => ({ ...m, ...Object.fromEntries(jobs.map(k => [k, plus(m[k], each)])) }))
      launchShare = launches ? each : undefined
      for (const id of [...named, ...mine]) {
        const t = bg.get(id)
        if (t && each) t.spent = plus(t.spent, each)
      }
      if (named.length + mine.length) await save($)
      const now = await $.clock.now()
      await update($, tokensAtom, t => ({
        since: t.since || now,
        in: t.in + u.input_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
        out: t.out + u.output_tokens,
      }))
    }
    return r
  })

  // /detaly: the band on the All tab, in a chat with no jobs of its own too
  on('command.run', { command: 'detaly' }, async $ => {
    await update($, miniAtom, () => false)
    await update($, tabAtom, () => 'all')
    return { text: 'Detaly: All tab.' }
  })

  // A new chat's tab is named by its first message. A background task's end: its notification, a prompt of its own
  // (idle, it starts the turn, which is then the task's) or delivered into a running turn.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification' || e.text.includes('<task-id>')) {
      const now = (await $.clock.now()) / 1000
      for (const [, id = '', status] of e.text.matchAll(NOTE)) {
        const t = bg.get(id)
        if (t && t.status === undefined) Object.assign(t, { endedAt: t.endedAt ?? now, status })
        if (t && !e.turnId) woke.push(id)
      }
      await save($)
    } else if (label === folder) label = labelOf(folder, e.text)
    return next(e)
  })
}
