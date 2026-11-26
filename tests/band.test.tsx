import { expect, test } from 'claude-code/testing'

const ROOT = '/repo'

const band = (isWorking: boolean, surface: 'desktop' | 'terminal' = 'desktop') =>
  ({
    plugin: 'm3-session',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 110,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }) as const

// The alt text of every Svg drawn, which names what each one shows.
const alts = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))

const svgByAlt = async (
  ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> },
  alt: RegExp,
) => (await ui.findAll({ type: 'Svg' })).find(svg => alt.test(String(svg.props.alt)))

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A repository on branch main with two changed files, register.tsx among them.
const fakeGit = (argv: readonly string[]) => {
  const args = argv.filter(a => a !== '-c' && a !== 'core.quotepath=off').slice(1).join(' ')

  if (args === 'rev-parse --abbrev-ref HEAD') return ok('main\n')
  if (args === 'status --porcelain') return ok(' M hooks/register.tsx\n?? notes.md\n')
  if (args === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`)
  if (args.startsWith('diff --numstat HEAD')) return ok('41\t12\thooks/register.tsx\n')
  if (args.startsWith('ls-files --others')) return ok('notes.md\n')

  return ok('')
}

test('while a turn runs, the band says what Claude is doing', async ($, on) => {
  let now = 1_000_000
  let seen: { alt?: unknown; source?: unknown } | undefined
  on('clock.now', () => ({ value: now }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  // Stands for the engine running the tool; mid-Edit it looks at the band.
  on('tool.call', async (_, e) => {
    if (e.tool === 'Edit') {
      const ui = await $.ui.mount(band(true))
      const line = await svgByAlt(ui, /^Editing register\.tsx, 2 steps so far$/)
      seen = line?.props
      await ui.unmount()
    }

    return { result: {} }
  })

  await $.prompt.submit({ text: 'fix the band' } as never)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/hooks/register.tsx` } as never)
  now += 42_000
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/hooks/register.tsx` } as never)

  expect(seen).toBeDefined()
  // The timer starts 42 s in and counts on by itself.
  expect(String(seen?.source)).toContain('animation-delay: -42s')
})

test('after a turn, the band sums it up with file and git chips', async ($, on) => {
  const copied: string[] = []
  on('clock.now', () => ({ value: 5_000 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))

  await $.prompt.submit({ text: 'edit two files' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/hooks/register.tsx` } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes.md` } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.turn.complete({
    answer: '',
    durationMs: 134_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  const ui = await $.ui.mount(band(false))
  expect(await alts(ui)).toContain('Last turn 2m 14s, 3 tools, 2 files changed')
  expect((await ui.find({ type: 'Button', key: 'git' }))?.props.label).toBe('⎇ main · 2 changed')
  expect((await ui.find({ type: 'Button', key: `file:${ROOT}/hooks/register.tsx` }))?.props.label).toBe('register.tsx +41 −12')
  expect((await ui.find({ type: 'Button', key: `file:${ROOT}/notes.md` }))?.props.label).toBe('notes.md · new')

  await ui.press({ key: `file:${ROOT}/hooks/register.tsx` })
  expect(copied).toEqual([`${ROOT}/hooks/register.tsx`])
  await ui.unmount()
})

test('on a plan with no 5h window (Ultra), the 5h ring shows ∞', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-26T00:00:00Z') }))
  on('session.measure', () => ({ changed: ['context', 'rateLimits'] }))

  await $.session.measure({
    context: { tokens: 190_000, window: 1_000_000, percent: 19 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 17, resetsAt: '2026-11-28T04:00:00Z' }],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount(band(false))
  const drawn = await alts(ui)
  expect(drawn).toEqual([
    'Context 19% used (190k of 1M)',
    'No turns yet in this session',
    '5h limit: none on this plan',
    '7d limit 17% used, resets in 2d 4h',
  ])
  await ui.unmount()
})

test('the Context chip unfolds the breakdown in the band, and folds it again', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 190_000,
        window: 1_000_000,
        percent: 19,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 12_000, kind: 'used' },
            { name: 'Messages', tokens: 170_000, kind: 'used' },
            { name: 'Free space', tokens: 818_000, kind: 'free' },
          ],
          totalTokens: 182_000,
          rawMaxTokens: 1_000_000,
          isAutoCompactEnabled: true,
          autoCompactThreshold: 830_000,
          model: 'claude-opus-5-5',
        } as never,
      },
      rateLimits: [],
    },
  }))

  const ui = await $.ui.mount(band(false))
  const unfolded = /^Context window by category: /

  expect(await svgByAlt(ui, unfolded)).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'context' }))?.props.label).toBe('Context')

  await ui.press({ key: 'context' })
  expect((await svgByAlt(ui, unfolded))?.props.alt).toBe(
    'Context window by category: System prompt 12k, Messages 170k',
  )
  const source = String((await svgByAlt(ui, unfolded))?.props.source)
  expect(source).toContain('182k of 1M used')
  expect(source).toContain('Auto-compact')
  expect((await ui.find({ type: 'Button', key: 'context' }))?.props.label).toBe('Hide context')

  await ui.press({ key: 'context' })
  expect(await svgByAlt(ui, unfolded)).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'context' }))?.props.label).toBe('Context')
  await ui.unmount()
})
