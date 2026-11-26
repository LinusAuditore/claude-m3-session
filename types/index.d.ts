/** The live context window, as the status line has it. */
export type Usage = {
  /** Input tokens of the last response; absent before the first one. */
  tokens?: number
  /** The model's context window in tokens. */
  window: number
  /** tokens / window, 0 to 100; absent before the first response. */
  percent?: number
}

/** One rate-limit window. */
export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  /** 0 to 100. */
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
}

/** The kind of step, which picks its icon. */
export type StepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'other'

/** What the main thread is doing during a turn. */
export type Activity = {
  /** When the turn started, in `$.clock.now()` milliseconds. */
  startedAt: number
  /** The step running now, or absent between steps (Claude is thinking). */
  current?: { kind: StepKind; label: string }
  /** The kinds of the steps so far, oldest first, at most the last 24. */
  steps: StepKind[]
  /** How many tool calls the turn has made. */
  count: number
  /**
   * Whether the turn began with the person's prompt. A turn that began some
   * other way (a background task's notice, say) continues the last summary.
   * Absent on what an earlier version stored, which counts as not prompted.
   */
  isPrompted?: boolean
}

/** A file the last turn wrote, with its change against HEAD where git knows it. */
export type FileStat = {
  path: string
  name: string
  added?: number
  removed?: number
  isNew?: boolean
}

export type TurnSummary = {
  durationMs: number
  tools: number
  files: FileStat[]
  isAborted: boolean
  /** Tokens the model read over the turn's requests, cached or not; absent
   *  when the turn reported no usage (an interrupt, an API error). */
  tokensIn?: number
  /** Tokens the model wrote over the turn's requests. */
  tokensOut?: number
}

export type GitState = {
  branch: string
  /** Files with changes, staged or not, untracked included. */
  changed: number
}

/** One row of the context breakdown. */
export type Slice = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type Breakdown = {
  slices: Slice[]
  total: number
  max: number
  compactAt?: number
  model: string
}

/** A next step offered as a chip; pressing it fills the input box with `text`. */
export type Suggestion = {
  /** The chip's words, in English like the rest of the band. */
  label: string
  /** What goes in the input box, in the language of the person's last prompt. */
  text: string
  /** `rule` from what the band knows; `ai` written by a small model (opt-in). */
  source: 'rule' | 'ai'
}

declare module 'claude-code' {
  interface PluginState {
    'm3-session': {
      usage: Usage | null
      limits: Limit[]
      activity: Activity | null
      last: TurnSummary | null
      git: GitState | null
      breakdown: Breakdown | null
      /** Whether the band shows the context breakdown under its chips. */
      isContextOpen: boolean
      /** The next steps offered after the last turn. */
      suggestions: Suggestion[]
      /** Whether a small model writes the suggestions (`/ai-suggestions`). */
      isAiOn: boolean
    }
  }
}
