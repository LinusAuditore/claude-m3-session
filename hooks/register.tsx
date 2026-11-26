import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Breakdown, FileStat, GitState, Limit, StepKind, TurnSummary, Usage } from '../types'
import {
  ACTIVITY_H,
  BADGE,
  RING_H,
  RING_W,
  SUMMARY_H,
  activityScene,
  badgeScene,
  breakdownScene,
  formatTokens,
  formatDuration,
  formatReset,
  limitName,
  ringScene,
  summaryScene,
  toneOf,
  unlimitedRingScene,
} from './scene'

const usage = atom({ plugin: 'm3-session', key: 'usage' } as const, null)
const limits = atom({ plugin: 'm3-session', key: 'limits' } as const, [])
const activity = atom({ plugin: 'm3-session', key: 'activity' } as const, null)
const last = atom({ plugin: 'm3-session', key: 'last' } as const, null)
const git = atom({ plugin: 'm3-session', key: 'git' } as const, null)
const breakdown = atom({ plugin: 'm3-session', key: 'breakdown' } as const, null)
const isContextOpen = atom({ plugin: 'm3-session', key: 'isContextOpen' } as const, false)

// 0.1.0 showed the breakdown in a pane; it now unfolds in the band, and a
// pane left open by that version is closed when the mod loads.
const OLD_PANE = 'm3-session-context'

// On desktop `bodyColumns` is the slot's width over the code font's advance:
// this is that advance, so columns times it is the slot in pixels.
const ADVANCE = 8.4
const GAP_PX = 12
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

// ----------------------------------------------------------- engine calls

async function nowMs($: EngineInterface): Promise<number> {
  return $.clock.now()
}

async function startTurn($: EngineInterface): Promise<void> {
  const startedAt = await nowMs($)
  running.clear()
  turnFiles.clear()
  await update($, activity, () => ({ startedAt, steps: [], count: 0 }))
}

async function ensureTurn($: EngineInterface): Promise<void> {
  if ((await read($, activity)) === null) {
    await startTurn($)
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

async function finishTurn($: EngineInterface, durationMs: number, isAborted: boolean): Promise<void> {
  const a = await read($, activity)
  const files = await statFiles($, [...turnFiles])
  const summary: TurnSummary = { durationMs, tools: a?.count ?? 0, files, isAborted }
  await update($, last, () => summary)
  await update($, activity, () => null)
  running.clear()
  turnFiles.clear()
  await refreshGit($)

  if (await read($, isContextOpen)) {
    await loadBreakdown($).catch(() => undefined)
  }
}

// --------------------------------------------------------------- labels

const fileLabel = (f: FileStat): string =>
  f.isNew === true
    ? `${f.name} · new`
    : f.added !== undefined
      ? `${f.name} +${f.added} −${f.removed ?? 0}`
      : f.name

const gitLabel = (g: GitState): string =>
  `⎇ ${g.branch} · ${g.changed === 0 ? 'clean' : `${g.changed} changed`}`

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    await refreshUsage($).catch(() => undefined)
    await refreshGit($)

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await startTurn($).catch(() => undefined)

    return result
  })

  on('tool.call', async ($, e, next) => {
    // Subagents' calls are theirs: the band follows the main thread.
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

    if (e.agentId !== undefined) {
      return result
    }

    await finishTurn($, e.durationMs, e.isAborted).catch(() => undefined)

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
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui

    const chips = (
      <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
        <Button
          key="context"
          label={isOpen ? 'Hide context' : 'Context'}
          variant={isOpen ? 'primary' : undefined}
          onPress={() => toggleContext($)}
        />
        {g === null ? null : <Button key="git" label={gitLabel(g)} onPress={() => copyBranch($, g.branch)} />}
        {files.slice(0, MAX_FILE_CHIPS).map(f => (
          <Button key={`file:${f.path}`} label={fileLabel(f)} onPress={() => copyPath($, f.path)} />
        ))}
        {files.length > MAX_FILE_CHIPS ? <Text dimColor>+{files.length - MAX_FILE_CHIPS} more</Text> : null}
      </Box>
    )

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
        <Box flexDirection="column">
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
          {isWorking ? null : chips}
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
    const slot = Math.round(e.props.bodyColumns * ADVANCE)
    const ringsW = (shownLimits.length + (isFiveHourUnlimited ? 1 : 0)) * (RING_W + GAP_PX)
    const middle = Math.max(240, slot - BADGE - GAP_PX - ringsW - 8)
    const badgeAlt =
      u?.percent === undefined
        ? 'Context: waiting for first reply'
        : `Context ${Math.round(u.percent)}% used${u.tokens === undefined ? '' : ` (${formatTokens(u.tokens)} of ${formatTokens(u.window)})`}`

    const body =
      isWorking ? (
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
                : `${summary.isAborted ? 'Stopped after' : 'Last turn'} ${formatDuration(summary.durationMs)}, ${summary.tools} tools, ${summary.files.length} files changed`
            }
            width={middle}
            height={SUMMARY_H}
          />
          {chips}
        </Box>
      )

    const unfolded = isWorking || b === null ? null : breakdownScene(b, Math.max(240, slot - 8))
    const row = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg source={badgeScene(u?.percent, isWorking)} alt={badgeAlt} width={BADGE} height={BADGE} />
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
        {isFiveHourUnlimited ? (
          <Svg
            key="limit:five_hour"
            source={unlimitedRingScene('five_hour')}
            alt="5h limit: none on this plan"
            width={RING_W}
            height={RING_H}
          />
        ) : null}
        {shownLimits.map(l => (
          <Svg
            key={`limit:${l.kind}`}
            source={ringScene(l, now)}
            alt={`${limitName(l.kind)} limit ${Math.round(l.percentUsed)}% used${formatReset(l.resetsAt, now) === undefined ? '' : `, ${formatReset(l.resetsAt, now)}`}`}
            width={RING_W}
            height={RING_H}
          />
        ))}
      </Box>
    )

    if (unfolded === null || b === null) {
      return row
    }

    return (
      <Box flexDirection="column" gap={1}>
        {row}
        <Svg
          source={unfolded.svg}
          alt={`Context window by category: ${b.slices
            .filter(slice => slice.tokens > 0)
            .map(slice => `${slice.name} ${formatTokens(slice.tokens)}`)
            .join(', ')}`}
          width={Math.max(240, slot - 8)}
          height={unfolded.height}
        />
      </Box>
    )
  })
}
