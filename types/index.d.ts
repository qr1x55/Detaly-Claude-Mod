// The Detaly mod's values in $.state: they outlive a reload of the mod within a session.

// A background shell the session started (Bash / PowerShell with run_in_background), seen from its tool call.
// `expectS`: its expected length from the description (a duration, or until a clock time: `isUntil`, exact even
// when the start is unknown); `isLate`: first seen at a turn's end, start unknown; `isCounted`: its output showed
// progress, so it ends with a full bar; `spent`: what Claude's responses about it cost (the one that launched it, the
// ones that read its output or named it, every one of a turn its end woke).
export type Spent = { tokensIn: number; out: number; usd: number; steps: number }
export type JobProgressTask = {
  title: string
  started: number
  expectS?: number
  isUntil?: boolean
  output?: string
  isLate?: boolean
  endedAt?: number
  endActive?: number // the presence clock (s the person spent at Claude) at its end
  status?: string
  isCounted?: boolean
  spent?: Spent
}

declare module 'claude-code' {
  interface PluginState {
    // tab: the band's open tab, "all" or a session's id ("" = this session); closed: tabs the person closed;
    // mini: the band minimized to this chat's rows, no tabs; tokens: the session's model responses summed since `since`
    // (ms); jobSpent: what Claude's responses about this chat's file jobs cost, by "<id>@<started>" (those whose tool
    // calls name the id)
    detaly: {
      tasks: [string, JobProgressTask][]
      tab: string
      closed: string[]
      mini: boolean
      tokens: { since: number; in: number; cacheRead: number; cacheWrite: number; out: number }
      jobSpent: Record<string, Spent>
    }
  }
}
