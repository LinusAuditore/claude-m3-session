import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/repo'

const band = (isWorking: boolean, surface: 'desktop' | 'terminal' = 'desktop', bodyColumns = 110) =>
  ({
    plugin: 'm3-session',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking,
      maxRows: 10,
      bodyColumns,
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

test('a turn that began without a prompt adds to the last summary', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  const done = (durationMs: number, turnId: string) =>
    $.turn.complete({ answer: '', durationMs, isAborted: false, turnId, reason: 'answer' } as never)

  await $.prompt.submit({ text: 'edit and check' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/hooks/register.tsx` } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await done(90_000, 't1')

  // A background task's notice wakes Claude: no prompt, one more call.
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes.md` } as never)
  await done(31_000, 't2')

  const ui = await $.ui.mount(band(false))
  expect(await alts(ui)).toContain('Last turn 2m 1s, 3 tools, 2 files changed')
  await ui.unmount()
})

test('a subagent\'s calls and turn are not the main thread\'s', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))

  await $.prompt.submit({ text: 'delegate a search' } as never)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` } as never)
  await $.tool.call({ tool: 'Agent', description: 'Search the repo' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'y', agentId: 'sub-1' } as never)
  await $.turn.complete({ answer: '', durationMs: 20_000, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'sub-1' } as never)
  await $.turn.complete({ answer: '', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount(band(false))
  expect(await alts(ui)).toContain('Last turn 1m 0s, 2 tools, 0 files changed')
  await ui.unmount()
})

test('the summary says how many tokens the turn read and wrote', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  const usage = (fresh: number, cached: number, written: number, out: number) => ({
    input_tokens: fresh,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: out,
    model: 'claude-opus-5-5',
  })

  await $.prompt.submit({ text: 'do it' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete({ answer: '', durationMs: 60_000, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(2_000, 3_900_000, 98_000, 15_000) } as never)
  // A prompt-less continuation adds its tokens.
  await $.turn.complete({ answer: '', durationMs: 10_000, isAborted: false, turnId: 't2', reason: 'answer', usage: usage(1_000, 99_000, 0, 3_000) } as never)

  const ui = await $.ui.mount(band(false))
  const line = await svgByAlt(ui, /^Last turn/)
  expect(line?.props.alt).toBe('Last turn 1m 10s, 1 tool, 0 files changed, 4.1M tokens in, 18k out')
  expect(String(line?.props.source)).toContain('4.1M in · 18k out')
  await ui.unmount()
})

test('a turn with no tools says so in words', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))

  await $.prompt.submit({ text: 'just answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 12_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount(band(false))
  const line = await svgByAlt(ui, /^Last turn 12s/)
  expect(String(line?.props.source)).toContain('no tools · no files changed')
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
  // Everything sits in one M3 container: a card drawn behind the content.
  const card = await ui.find({ type: 'Box', key: 'card' })
  expect(card?.props.position).toBe('relative')
  const background = await svgByAlt(ui, /^Session band$/)
  expect(String(background?.props.source)).toContain('rx="24"')
  expect(background?.props.height).toBe(80)
  const drawn = await alts(ui)
  expect(drawn).toEqual([
    'Session band',
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
  // The card grows to hold the breakdown.
  expect(((await svgByAlt(ui, /^Session band$/))?.props.height as number) > 80).toBe(true)
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

// ------------------------------------------------------------ suggestions

const turnWithEdits = async ($: Engine, prompt: string) => {
  await $.prompt.submit({ text: prompt } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/hooks/register.tsx` } as never)
  await $.turn.complete({ answer: 'Done: the band now fills the input box.', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
}

// Lets a reply that was not awaited (the model's) land: a few turns of the
// microtask queue, as the stubs answer at once.
const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve()
  }
}

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('after a turn, rule chips offer next steps and fill the input box in the prompt\'s language', async ($, on) => {
  const filled: string[] = []
  let modelCalls = 0
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  on('model.complete', () => {
    modelCalls += 1

    return { value: { isAnswered: true, text: '[]', usage: USAGE } }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    // An event: its stub returns the result itself, not { value }.
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await turnWithEdits($, '把横带改成可以填入建议')
  await settle()

  const ui = await $.ui.mount(band(false))
  const chips = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('suggest:'))
  expect(chips.map(c => c.props.label)).toEqual(['Run the tests', 'Review the changes', 'Commit these changes'])
  // The card grows by the suggestion line, which keeps a gap from the chips.
  expect((await svgByAlt(ui, /^Session band$/))?.props.height).toBe(106)
  const rows = (await ui.findAll({ type: 'Box' })).filter(box => box.props.marginTop === 'sm')
  expect(rows.length).toBe(1)

  await ui.press({ key: 'suggest:0' })
  expect(filled).toEqual(['运行测试，修复失败的部分。'])
  // Off by default: no model is asked.
  expect(modelCalls).toBe(0)
  await ui.unmount()
})

test('with /ai-suggestions on, a small model writes the chips, marked ✦', async ($, on) => {
  const asked: string[] = []
  let stored: unknown
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  on('store.set', (_, e) => {
    stored = e.value

    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    asked.push(String(e.model))

    return {
      value: {
        isAnswered: true,
        text: 'Here you go: [{"label": "Add a settings toggle", "text": "Add a toggle for the band in settings."}, {"label": "Write the changelog", "text": "Write a changelog entry for this."}]',
        usage: USAGE,
      },
    }
  })

  const said = await $.command.run({ command: 'ai-suggestions', args: 'on' } as never)
  expect(stored).toBe(true)
  expect(String(said.text)).toContain('AI suggestions on')

  await turnWithEdits($, 'make the chips fill the input box')
  await settle()

  const ui = await $.ui.mount(band(false))
  const chips = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('suggest:'))
  expect(chips.map(c => c.props.label)).toEqual(['✦ Add a settings toggle', '✦ Write the changelog'])
  expect(asked).toEqual(['haiku'])
  await ui.unmount()
})

test('a model reply that is not the JSON asked for leaves the rule chips', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_, e) => fakeGit(e.argv))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  on('store.set', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Sure! You could run the tests.', usage: USAGE } }))

  await $.command.run({ command: 'ai-suggestions', args: 'on' } as never)
  await turnWithEdits($, 'make the chips fill the input box')
  await settle()

  const ui = await $.ui.mount(band(false))
  const chips = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('suggest:'))
  expect(chips.map(c => c.props.label)).toEqual(['Run the tests', 'Review the changes', 'Commit these changes'])
  await ui.unmount()
})

test('in a narrow band, a long worktree branch and the rings give way so all of it fits', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-26T00:00:00Z') }))
  on('process.run', (_, e) => {
    const args = e.argv.filter(a => a !== '-c' && a !== 'core.quotepath=off').slice(1).join(' ')

    return args === 'rev-parse --abbrev-ref HEAD' ? ok('claude/elastic-ramanujan-4deedf\n') : fakeGit(e.argv)
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '', reason: 'answer' }))
  on('session.measure', () => ({ changed: ['context', 'rateLimits'] }))

  await $.session.measure({
    context: { tokens: 270_000, window: 1_000_000, percent: 27 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 45, resetsAt: '2026-11-28T04:00:00Z' }],
    changed: ['context', 'rateLimits'],
  })
  await $.prompt.submit({ text: 'edit' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/hooks/register.tsx` } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes.md` } as never)
  await $.turn.complete({
    answer: '',
    durationMs: 760_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { input_tokens: 5_500_000, output_tokens: 74_000, model: 'claude-opus-5-5' },
  } as never)

  // About 750 px, the app's chat column in a half-width window.
  const ui = await $.ui.mount(band(false, 'desktop', 89))
  const label = String((await ui.find({ type: 'Button', key: 'git' }))?.props.label)
  expect(label.startsWith('⎇ elastic')).toBe(true)
  expect(label.includes('claude/')).toBe(false)
  expect(label.length).toBeLessThanOrEqual(40)
  // The rings draw compact, the value inside, the window beneath.
  const seven = await svgByAlt(ui, /^7d limit/)
  expect(seven?.props.width).toBeLessThanOrEqual(52 + 16)
  expect(String(seven?.props.source)).toContain('>45</text>')
  expect((await svgByAlt(ui, /^5h limit/))?.props.width).toBe(52)
  // The whole summary line still fits the column it is drawn in.
  expect(String((await svgByAlt(ui, /^Last turn/))?.props.source)).toContain('5.5M in · 74k out')
  await ui.unmount()
})
