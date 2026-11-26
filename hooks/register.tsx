import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Breakdown, FileStat, GitState, Limit, StepKind, Suggestion, TurnSummary, Usage } from '../types'
import {
  ACTIVITY_H,
  BADGE,
  CARD_BOTTOM,
  PAD_X,
  RING_H,
  RING_COMPACT_W,
  RING_W,
  ROW_H,
  SUMMARY_H,
  activityScene,
  badgeScene,
  breakdownScene,
  cardScene,
  inset,
  formatTokens,
  formatDuration,
  formatReset,
  limitName,
  ringScene,
  summaryScene,
  toneOf,
  unlimitedRingScene,
} from './scene'
import { AI_SYSTEM, MAX_SUGGESTIONS, aiPrompt, langOf, parseAi, ruleSuggestions } from './suggest'

const usage = atom({ plugin: 'm3-session', key: 'usage' } as const, null)
const limits = atom({ plugin: 'm3-session', key: 'limits' } as const, [])
const activity = atom({ plugin: 'm3-session', key: 'activity' } as const, null)
const last = atom({ plugin: 'm3-session', key: 'last' } as const, null)
const git = atom({ plugin: 'm3-session', key: 'git' } as const, null)
const breakdown = atom({ plugin: 'm3-session', key: 'breakdown' } as const, null)
const isContextOpen = atom({ plugin: 'm3-session', key: 'isContextOpen' } as const, false)
const suggestions = atom({ plugin: 'm3-session', key: 'suggestions' } as const, [])
const isAiOn = atom({ plugin: 'm3-session', key: 'isAiOn' } as const, false)

// The setting behind `/ai-suggestions`, kept across sessions in `$.store`.
const AI_STORE_KEY = 'aiSuggestions'
const AI_COMMAND = 'ai-suggestions'
// A suggestion row's height on desktop: the card grows by it.
const SUGGEST_ROW_H = 26

// 0.1.0 showed the breakdown in a pane; it now unfolds in the band, and a
// pane left open by that version is closed when the mod loads.
const OLD_PANE = 'm3-session-context'

// On desktop `bodyColumns` is the slot's width over the code font's advance:
// this is that advance, so columns times it is the slot in pixels.
const ADVANCE = 8.4
// The space between the badge and what follows it, in px.
const BADGE_GAP = 12
// A chip's width, estimated from its label: the app draws the Buttons, so
// their size is not known; the estimate keeps the chips on one line.
const chipWidth = (label: string): number => Math.round(label.length * 7.4) + 30
const CHIP_GAP = 8
const MORE_ROOM = 64
// The narrowest the middle column may be before the rings draw compact.
const MIN_MIDDLE = 460
const MAX_STEPS = 24
const MAX_FILE_CHIPS = 4

// ------------------------------------------------------------- tool steps

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const field = (e: unknown, key: string): string | undefined => {
  const value = (e as Record<string, unknown>)[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const hostOf = (url: string): string => url.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? url

const oneLine = (text: string): string => text.replace(/\s+/g, ' ')

// What a tool call is doing, in a few words, and its icon.
const describe = (e: { tool: string }): { kind: StepKind; label: string } => {
  const file = field(e, 'file_path') ?? field(e, 'notebook_path')

  switch (e.tool) {
    case 'Read':
      return { kind: 'read', label: file === undefined ? 'Reading a file' : `Reading ${basename(file)}` }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', label: file === undefined ? 'Editing a file' : `Editing ${basename(file)}` }
    case 'Write':
      return { kind: 'edit', label: file === undefined ? 'Writing a file' : `Writing ${basename(file)}` }
    case 'Bash': {
      const command = field(e, 'command')

      return { kind: 'run', label: command === undefined ? 'Running a command' : `Running ${oneLine(command)}` }
    }
    case 'Grep': {
      const pattern = field(e, 'pattern')

      return { kind: 'search', label: pattern === undefined ? 'Searching' : `Searching for ${oneLine(pattern)}` }
    }
    case 'Glob': {
      const pattern = field(e, 'pattern')

      return { kind: 'search', label: pattern === undefined ? 'Finding files' : `Finding ${pattern}` }
    }
    case 'WebFetch': {
      const url = field(e, 'url')

      return { kind: 'web', label: url === undefined ? 'Fetching a page' : `Fetching ${hostOf(url)}` }
    }
    case 'WebSearch': {
      const query = field(e, 'query')

      return { kind: 'web', label: query === undefined ? 'Searching the web' : `Searching the web for ${oneLine(query)}` }
    }
    case 'Agent':
    case 'Task': {
      const what = field(e, 'description')

      return { kind: 'agent', label: what === undefined ? 'Running an agent' : `Agent: ${oneLine(what)}` }
    }
    case 'TodoWrite':
      return { kind: 'plan', label: 'Updating the plan' }
    case 'Skill': {
      const skill = field(e, 'skill')

      return { kind: 'agent', label: skill === undefined ? 'Using a skill' : `Using ${skill}` }
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(e.tool)

      if (mcp !== null) {
        return { kind: 'other', label: `${mcp[1]} · ${mcp[2]}` }
      }

      return { kind: 'other', label: e.tool }
    }
  }
}

const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// Module state for the turn in progress (a reload starts it over, which only
// loses the file list of a turn that is mid-way).
const running = new Map<string, { kind: StepKind; label: string }>()
const turnFiles = new Set<string>()
let callSerial = 0
// The person's last prompt, for the language of the filled text and for the
// model's view of the exchange (a reload forgets it, which costs only that).
let lastPrompt = ''
// Bumped per turn, so a model reply that arrives after a new turn began is
// dropped rather than shown for the wrong turn.
let turnSerial = 0

// ----------------------------------------------------------- engine calls

async function nowMs($: EngineInterface): Promise<number> {
  return $.clock.now()
}

async function startTurn($: EngineInterface, isPrompted: boolean): Promise<void> {
  const startedAt = await nowMs($)
  running.clear()
  turnFiles.clear()
  await update($, activity, () => ({ startedAt, steps: [], count: 0, isPrompted }))
}

// A tool call with no turn under way: the turn began without a prompt.
async function ensureTurn($: EngineInterface): Promise<void> {
  if ((await read($, activity)) === null) {
    await startTurn($, false)
  }
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const now = await $.session.usage()
  await update($, usage, () => toUsage(now.context))
  await update($, limits, () => toLimits(now.rateLimits))
}

const toUsage = (c: { tokens?: number; window: number; percent?: number }): Usage => ({
  tokens: c.tokens,
  window: c.window,
  percent: c.percent,
})

const toLimits = (list: readonly Limit[]): Limit[] =>
  list.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))

async function runGit($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  try {
    const out = await $.process.run(['git', '-c', 'core.quotepath=off', ...args], { timeoutMs: 5000 })

    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

async function refreshGit($: EngineInterface): Promise<void> {
  const branch = await runGit($, ['rev-parse', '--abbrev-ref', 'HEAD'])

  if (branch === undefined) {
    await update($, git, () => null)

    return
  }

  const status = (await runGit($, ['status', '--porcelain'])) ?? ''
  const changed = status.split('\n').filter(line => line.trim() !== '').length
  const state: GitState = { branch: branch.trim(), changed }
  await update($, git, () => state)
}

// Each file the turn wrote, with its change against HEAD where git knows it.
async function statFiles($: EngineInterface, paths: readonly string[]): Promise<FileStat[]> {
  const stats: FileStat[] = paths.map(path => ({ path, name: basename(path) }))
  const root = (await runGit($, ['rev-parse', '--show-toplevel']))?.trim()

  if (root === undefined || root === '') {
    return stats
  }

  const inside = paths.filter(path => path.startsWith(`${root}/`))

  if (inside.length === 0) {
    return stats
  }

  const numstat = (await runGit($, ['diff', '--numstat', 'HEAD', '--', ...inside])) ?? ''
  const untracked = (await runGit($, ['ls-files', '--others', '--exclude-standard', '--full-name', '--', ...inside])) ?? ''

  for (const line of numstat.split('\n')) {
    const [added, removed, rel] = line.split('\t')

    if (rel === undefined) {
      continue
    }

    const stat = stats.find(s => s.path === `${root}/${rel}`)

    if (stat !== undefined && added !== '-') {
      stat.added = Number(added)
      stat.removed = Number(removed)
    }
  }

  for (const rel of untracked.split('\n')) {
    const stat = stats.find(s => s.path === `${root}/${rel.trim()}`)

    if (stat !== undefined && rel.trim() !== '') {
      stat.isNew = true
    }
  }

  return stats
}

// The window by category, from the local (free) estimate /context makes.
async function loadBreakdown($: EngineInterface): Promise<void> {
  const now = await $.session.usage({ breakdown: 'summary' })
  const b = now.context.breakdown

  if (b === undefined) {
    return
  }

  const value: Breakdown = {
    slices: b.categories
      .filter(c => c.kind === 'used' || c.kind === 'buffer')
      .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    total: b.totalTokens,
    max: b.rawMaxTokens,
    compactAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    model: b.model,
  }
  await update($, breakdown, () => value)
}

// Unfolds the breakdown in the band, read fresh, or folds it away.
async function toggleContext($: EngineInterface): Promise<void> {
  if (await read($, isContextOpen)) {
    await update($, isContextOpen, () => false)

    return
  }

  await loadBreakdown($).catch(() => undefined)
  await update($, isContextOpen, () => true)
}

async function copyPath($: EngineInterface, path: string): Promise<void> {
  const copied = await $.ui.copy({ text: path })

  if (copied.isCopied) {
    $.ui.toast(`Copied ${basename(path)}`)
  }
}

async function copyBranch($: EngineInterface, branch: string): Promise<void> {
  const copied = await $.ui.copy({ text: branch })

  if (copied.isCopied) {
    $.ui.toast(`Copied ${branch}`)
  }
}

type TurnTokens = { in: number; out: number }

// What the model read (uncached, cache-read and cache-written input, summed
// over the turn's requests) and what it wrote.
const tokensOf = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined): TurnTokens | undefined =>
  u === undefined
    ? undefined
    : {
        // Guarded: a usage without its cache fields must not sum to NaN.
        in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0,
      }

// "Last turn" is everything since the person's last prompt: a turn that began
// some other way (a background task's notice, a wake-up) adds its time, tools
// and files to the summary instead of replacing it.
async function finishTurn(
  $: EngineInterface,
  durationMs: number,
  isAborted: boolean,
  answer: string,
  turnUsage: TurnTokens | undefined,
): Promise<void> {
  const a = await read($, activity)
  const previous = await read($, last)
  // The summary this turn continues, or none when it began with a prompt.
  const base = a?.isPrompted === true ? null : previous
  const paths = new Set(base === null ? [] : base.files.map(f => f.path))

  for (const file of turnFiles) {
    paths.add(file)
  }

  const files = await statFiles($, [...paths])
  const tools = a?.count ?? 0
  const add = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const summary: TurnSummary =
    base === null
      ? { durationMs, tools, files, isAborted, tokensIn: turnUsage?.in, tokensOut: turnUsage?.out }
      : {
          durationMs: base.durationMs + durationMs,
          tools: base.tools + tools,
          files,
          isAborted,
          tokensIn: add(base.tokensIn, turnUsage?.in),
          tokensOut: add(base.tokensOut, turnUsage?.out),
        }
  await update($, last, () => summary)
  await update($, activity, () => null)
  running.clear()
  turnFiles.clear()
  await refreshGit($)

  if (await read($, isContextOpen)) {
    await loadBreakdown($).catch(() => undefined)
  }

  await suggest($, summary, answer)
}

// Rule chips at once; with /ai-suggestions on, a small model's in their place
// once it answers (the rules stay if it fails or answers nothing usable).
async function suggest($: EngineInterface, summary: TurnSummary, answer: string): Promise<void> {
  const g = await read($, git)
  const u = await read($, usage)
  const rules = ruleSuggestions(summary, g, u?.percent, langOf(lastPrompt))
  await update($, suggestions, () => rules)

  if (!(await read($, isAiOn)) || lastPrompt.trim() === '') {
    return
  }

  // Not awaited: the turn's end is not held up by the model.
  void writeSuggestions($, summary, answer, g).catch(() => undefined)
}

async function writeSuggestions(
  $: EngineInterface,
  summary: TurnSummary,
  answer: string,
  g: GitState | null,
): Promise<void> {
  const serial = turnSerial
  const reply = await $.model.complete({
    model: 'haiku',
    system: AI_SYSTEM,
    prompt: aiPrompt(lastPrompt, answer, summary, g),
    maxTokens: 300,
  })

  if (!reply.isAnswered || serial !== turnSerial) {
    return
  }

  const written = parseAi(reply.text)

  if (written.length > 0) {
    await update($, suggestions, () => written)
  }
}

async function fillPrompt($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast(filled.refusal === 'dialog' ? 'Close the dialog first' : "Couldn't fill the input box")
  }
}

async function loadAiSetting($: EngineInterface): Promise<void> {
  const stored = await $.store.get(AI_STORE_KEY)
  await update($, isAiOn, () => stored === true)
}

async function setAi($: EngineInterface, isOn: boolean): Promise<void> {
  await $.store.set(AI_STORE_KEY, isOn)
  await update($, isAiOn, () => isOn)
}

// --------------------------------------------------------------- labels

const fileLabel = (f: FileStat): string =>
  f.isNew === true
    ? `${f.name} · new`
    : f.added !== undefined
      ? `${f.name} +${f.added} −${f.removed ?? 0}`
      : f.name

// Claude's worktrees all live under claude/; the rest of the name says which.
const shownBranch = (branch: string): string => branch.replace(/^claude\//, '')

// The middle of a long name gives way first: its start and its end (a
// worktree's hash) are what tell branches apart.
const squeeze = (text: string, chars: number): string => {
  if (text.length <= chars) {
    return text
  }

  const keep = Math.max(2, chars - 1)
  const tail = Math.floor(keep / 2)

  return `${text.slice(0, keep - tail)}…${text.slice(text.length - tail)}`
}

// The git chip in at most `chars` characters: the branch is squeezed, and
// only when it would drop under ten characters is the change count left out.
const gitLabel = (g: GitState, chars = Number.POSITIVE_INFINITY): string => {
  const name = shownBranch(g.branch)
  const status = ` · ${g.changed === 0 ? 'clean' : `${g.changed} changed`}`
  const room = chars - 2 - status.length

  if (name.length <= room || room >= 10) {
    return `⎇ ${squeeze(name, room)}${status}`
  }

  return `⎇ ${squeeze(name, Math.max(6, chars - 2))}`
}

// The characters a chip `px` wide holds, the inverse of chipWidth.
const charsIn = (px: number): number => Math.floor((px - 30) / 7.4)

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    await refreshUsage($).catch(() => undefined)
    await refreshGit($)
    await loadAiSetting($).catch(() => undefined)
    await $.command
      .register({
        name: AI_COMMAND,
        description: 'Have a small model write the band\'s suggestion chips after each turn',
        argumentHint: 'on | off',
      })
      .catch(() => undefined)

    return result
  })

  on('command.run', { command: AI_COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isAiOn))
    await setAi($, isOn)

    return {
      text: isOn
        ? 'AI suggestions on: after each turn a small model (Haiku) writes the suggestion chips from your last message and the reply. It adds a little to /cost.'
        : 'AI suggestions off: the chips come from rules only, with no model calls.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    turnSerial += 1

    // A slash command is not a prompt to suggest from.
    if (e.command === undefined && e.text.trim() !== '') {
      lastPrompt = e.text
    }

    await startTurn($, true).catch(() => undefined)

    return result
  })

  on('tool.call', async ($, e, next) => {
    // Subagents' calls are theirs (the main loop carries no agentId, as the
    // desktop app confirmed): the band follows the main thread.
    if (e.agentId !== undefined) {
      return next(e)
    }

    // Everything the band does around the call is guarded: a failure here
    // costs a band update, never the call itself (or a second run of it).
    callSerial += 1
    const id = e.tool_use_id ?? `call-${callSerial}`

    try {
      await ensureTurn($)
      const step = describe(e)
      running.set(id, step)
      await update($, activity, a =>
        a === null
          ? a
          : { ...a, current: step, steps: [...a.steps, step.kind].slice(-MAX_STEPS), count: a.count + 1 },
      )
    } catch {
      // The band misses this step.
    }

    const ran = await next(e)

    try {
      running.delete(id)

      if (WRITES.has(e.tool) && ran.deny === undefined && ran.isError !== true) {
        const file = field(e, 'file_path') ?? field(e, 'notebook_path')

        if (file !== undefined) {
          turnFiles.add(file)
        }
      }

      // The newest call still running, or none (Claude is thinking).
      const still = [...running.values()].pop()
      await update($, activity, a => (a === null ? a : { ...a, current: still }))
    } catch {
      // The band keeps its last step.
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // A subagent's own turn ending is not the main thread's.
    if (e.agentId !== undefined) {
      return result
    }

    await finishTurn($, e.durationMs, e.isAborted, e.answer, tokensOf(e.usage)).catch(() => undefined)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, usage, () => toUsage(e.context))
    }

    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toLimits(e.rateLimits))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const u = await read($, usage)
    const shownLimits = (await read($, limits)).slice(0, 2)
    // An account that reports its windows but no 5h one has no 5h limit
    // (Ultra): it gets a ring with ∞. With no windows at all, nothing shows.
    const isFiveHourUnlimited =
      shownLimits.length > 0 && !shownLimits.some(l => l.kind === 'five_hour')
    const a = await read($, activity)
    const summary = await read($, last)
    const g = await read($, git)
    const now = await $.clock.now()
    const isWorking = e.props.isWorking
    const tone = toneOf(u?.percent)
    const files = summary?.files ?? []
    const isOpen = await read($, isContextOpen)
    const b = isOpen ? await read($, breakdown) : null
    const offered = isWorking ? [] : await read($, suggestions)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui

    const contextLabel = isOpen ? 'Hide context' : 'Context'

    // The chips on one line: Context, git, then as many files as fit `room`
    // (px; unlimited on the terminal, which wraps), the rest as "+n more".
    const chipsFor = (room: number) => {
      // The git chip gets what Context and a "+n more" leave it.
      const gitText =
        g === null
          ? ''
          : gitLabel(g, charsIn(room - chipWidth(contextLabel) - CHIP_GAP - (files.length > 0 ? MORE_ROOM : 0)))
      let used = chipWidth(contextLabel) + (g === null ? 0 : CHIP_GAP + chipWidth(gitText))
      const fitted: FileStat[] = []

      for (const f of files.slice(0, MAX_FILE_CHIPS)) {
        const w = CHIP_GAP + chipWidth(fileLabel(f))
        const isLast = fitted.length + 1 === files.length

        if (used + w + (isLast ? 0 : MORE_ROOM) > room) {
          break
        }

        fitted.push(f)
        used += w
      }

      const more = files.length - fitted.length

      return (
        // No overflow clipping: it cut off the app's button corners and the
        // outline ring that gives a light-mode chip its contrast. The chips
        // are fitted to the width above instead.
        <Box flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
          <Button
            key="context"
            label={contextLabel}
            variant={isOpen ? 'primary' : undefined}
            onPress={() => toggleContext($)}
          />
          {g === null ? null : <Button key="git" label={gitText} onPress={() => copyBranch($, g.branch)} />}
          {fitted.map(f => (
            <Button key={`file:${f.path}`} label={fileLabel(f)} onPress={() => copyPath($, f.path)} />
          ))}
          {more > 0 ? <Text dimColor>+{more} more</Text> : null}
        </Box>
      )
    }

    // The suggestions on one line: as many as fit `room`; pressing one fills
    // the input box, nothing is sent. Written ones carry a ✦.
    const suggestionsFor = (room: number) => {
      let used = 0
      const fitted: Suggestion[] = []

      for (const s of offered.slice(0, MAX_SUGGESTIONS)) {
        const w = (fitted.length === 0 ? 0 : CHIP_GAP) + chipWidth(s.label) + (s.source === 'ai' ? 14 : 0)

        if (used + w > room) {
          break
        }

        fitted.push(s)
        used += w
      }

      // The app's Buttons stand a little taller than the row that holds them,
      // so a second row of them needs a gap or it runs into the first.
      return (
        <Box flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center" marginTop="sm">
          {fitted.map((s, i) => (
            <Button
              key={`suggest:${i}`}
              label={s.source === 'ai' ? `✦ ${s.label}` : s.label}
              dimColor
              onPress={() => fillPrompt($, s.text)}
            />
          ))}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const percent = u?.percent === undefined ? '–' : `${Math.round(u.percent)}%`
      const current = a?.current?.label ?? 'Thinking'
      const elapsed = a === null ? '' : ` ${formatDuration(now - a.startedAt)}`
      const line = isWorking
        ? `${current}${elapsed} · ${a?.count ?? 0} steps`
        : summary === null
          ? 'Ready'
          : `${summary.isAborted ? 'Stopped after' : 'Last turn'} ${formatDuration(summary.durationMs)} · ${summary.tools} tools · ${summary.files.length} files`

      return (
        <Box key="card" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold>{percent}</Text>
            <Text>{line}</Text>
            {isFiveHourUnlimited ? (
              <Text key="five_hour" dimColor>
                5h ∞
              </Text>
            ) : null}
            {shownLimits.map(l => (
              <Text key={l.kind} dimColor>
                {limitName(l.kind)} {Math.round(l.percentUsed)}%
              </Text>
            ))}
          </Box>
          {isWorking ? null : chipsFor(Number.POSITIVE_INFINITY)}
          {offered.length === 0 ? null : suggestionsFor(Number.POSITIVE_INFINITY)}
          {isWorking || b === null
            ? null
            : b.slices
                .filter(slice => slice.tokens > 0)
                .map(slice => (
                  <Text key={`slice:${slice.name}`} dimColor>
                    {slice.name} {formatTokens(slice.tokens)}
                  </Text>
                ))}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    // The band's whole width; the card is drawn to it, and everything inside
    // carries its own spacing in px, so the card's height is known.
    const W = Math.round(e.props.bodyColumns * ADVANCE)
    const badgeW = PAD_X + BADGE + BADGE_GAP
    const ringCount = shownLimits.length + (isFiveHourUnlimited ? 1 : 0)
    // Rings draw compact when full ones would leave the middle too narrow.
    const isCompact = W - badgeW - (ringCount * RING_W + PAD_X) < MIN_MIDDLE
    const ringW = isCompact ? RING_COMPACT_W : RING_W
    const ringsW = ringCount * ringW + PAD_X
    const middle = Math.max(240, W - badgeW - ringsW)
    // The row grows by a line when there are suggestions to offer.
    const rowH = ROW_H + (offered.length > 0 ? SUGGEST_ROW_H : 0)
    const ringY = (rowH - RING_H) / 2
    // The last ring's frame holds the card's right padding.
    const ringFrameW = (index: number): number => ringW + (index === ringCount - 1 ? PAD_X : 0)
    const badgeAlt =
      u?.percent === undefined
        ? 'Context: waiting for first reply'
        : `Context ${Math.round(u.percent)}% used${u.tokens === undefined ? '' : ` (${formatTokens(u.tokens)} of ${formatTokens(u.window)})`}`

    const body = isWorking ? (
      <Svg
        source={activityScene(
          a ?? { startedAt: now, steps: [], count: 0 },
          Math.max(0, Math.floor((now - (a?.startedAt ?? now)) / 1000)),
          tone,
          middle,
        )}
        alt={`${a?.current?.label ?? 'Thinking'}, ${a?.count ?? 0} steps so far`}
        width={middle}
        height={ACTIVITY_H}
      />
    ) : (
      <Box flexDirection="column" gap={0}>
        <Svg
          source={summaryScene(summary, tone, middle)}
          alt={
            summary === null
              ? 'No turns yet in this session'
              : `${summary.isAborted ? 'Stopped after' : 'Last turn'} ${formatDuration(summary.durationMs)}, ${summary.tools === 1 ? '1 tool' : `${summary.tools} tools`}, ${summary.files.length === 1 ? '1 file' : `${summary.files.length} files`} changed${summary.tokensIn === undefined ? '' : `, ${formatTokens(summary.tokensIn)} tokens in, ${formatTokens(summary.tokensOut ?? 0)} out`}`
          }
          width={middle}
          height={SUMMARY_H}
        />
        {chipsFor(middle)}
        {offered.length === 0 ? null : suggestionsFor(middle)}
      </Box>
    )

    const rings = [
      ...(isFiveHourUnlimited ? [{ key: 'limit:five_hour', svg: unlimitedRingScene('five_hour', isCompact), alt: '5h limit: none on this plan' }] : []),
      ...shownLimits.map(l => ({
        key: `limit:${l.kind}`,
        svg: ringScene(l, now, isCompact),
        alt: `${limitName(l.kind)} limit ${Math.round(l.percentUsed)}% used${formatReset(l.resetsAt, now) === undefined ? '' : `, ${formatReset(l.resetsAt, now)}`}`,
      })),
    ]

    const unfolded = isWorking || b === null ? null : breakdownScene(b, W - PAD_X * 2)
    const unfoldedH = unfolded === null ? 0 : unfolded.height + CARD_BOTTOM
    const cardH = rowH + unfoldedH

    // The card is in the flow and sets the band's size; the content lies on
    // an absolute layer over it, which paints above it (an absolute card
    // behind positioned content was drawn over it in the app).
    return (
      <Box key="card" position="relative" flexDirection="column">
        <Svg source={cardScene(W, cardH)} alt="Session band" width={W} height={cardH} />
        <Box position="absolute" top={0} left={0} width="100%" flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={0}>
            <Svg
              source={inset(badgeScene(u?.percent, isWorking), badgeW, rowH, PAD_X, (rowH - BADGE) / 2)}
              alt={badgeAlt}
              width={badgeW}
              height={rowH}
            />
            <Box flexDirection="column" flexGrow={1}>
              {body}
            </Box>
            {rings.map((ring, index) => (
              <Svg
                key={ring.key}
                source={inset(ring.svg, ringFrameW(index), rowH, 0, ringY)}
                alt={ring.alt}
                width={ringFrameW(index)}
                height={rowH}
              />
            ))}
          </Box>
          {unfolded === null || b === null ? null : (
            <Svg
              source={inset(unfolded.svg, W, unfoldedH, PAD_X, 0)}
              alt={`Context window by category: ${b.slices
                .filter(slice => slice.tokens > 0)
                .map(slice => `${slice.name} ${formatTokens(slice.tokens)}`)
                .join(', ')}`}
              width={W}
              height={unfoldedH}
            />
          )}
        </Box>
      </Box>
    )
  })
}
