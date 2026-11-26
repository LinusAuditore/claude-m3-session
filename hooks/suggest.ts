// Suggestion chips: next steps offered after a turn. Pressing one fills the
// input box; nothing is ever sent for the person. Pure functions only:
// register.tsx gathers the facts and calls the model.

import type { GitState, Suggestion, TurnSummary } from '../types'

export const MAX_SUGGESTIONS = 3

// Files whose change is worth a test run.
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|sh|vue|svelte)$/i

// The person writes in Chinese, or not: the filled text follows their last
// prompt, while chip labels stay English like the rest of the band.
export type Lang = 'zh' | 'en'

export const langOf = (prompt: string): Lang => (/[㐀-鿿]/.test(prompt) ? 'zh' : 'en')

const TEXT: Record<string, Record<Lang, string>> = {
  continue: { en: 'Continue where you left off.', zh: '从刚才停下的地方继续。' },
  test: { en: 'Run the tests and fix anything that fails.', zh: '运行测试，修复失败的部分。' },
  review: {
    en: 'Review the changes you just made for bugs and missed edge cases.',
    zh: '检查一下刚才的改动，看有没有 bug 或遗漏的边界情况。',
  },
  commit: { en: 'Commit these changes with a clear message.', zh: '把这些改动 commit，写清楚提交说明。' },
  sumUp: {
    en: "Sum up what we've done so far and what's left, so the context can be compacted.",
    zh: '总结一下目前做了什么、还剩什么，方便之后压缩上下文。',
  },
}

const rule = (label: string, key: string, lang: Lang): Suggestion => ({
  label,
  text: TEXT[key]?.[lang] ?? '',
  source: 'rule',
})

// From what the band already knows, at most three, most pressing first.
export const ruleSuggestions = (
  summary: TurnSummary | null,
  git: GitState | null,
  percent: number | undefined,
  lang: Lang,
): Suggestion[] => {
  const out: Suggestion[] = []
  const files = summary?.files ?? []

  if (summary?.isAborted === true) {
    out.push(rule('Continue', 'continue', lang))
  }

  if (files.some(f => CODE.test(f.path))) {
    out.push(rule('Run the tests', 'test', lang))
  }

  if (files.length > 0) {
    out.push(rule('Review the changes', 'review', lang))
  }

  if (git !== null && git.changed > 0) {
    out.push(rule('Commit these changes', 'commit', lang))
  }

  if ((percent ?? 0) >= 70) {
    out.push(rule('Sum up so far', 'sumUp', lang))
  }

  return out.slice(0, MAX_SUGGESTIONS)
}

const clip = (text: string, chars: number): string =>
  text.length <= chars ? text : `${text.slice(0, chars)}…`

export const AI_SYSTEM =
  'You suggest what a developer might type next to their coding assistant. ' +
  'Reply with a JSON array only, no prose: up to 3 objects {"label": string, "text": string}. ' +
  '"label" is 2 to 4 plain English words in sentence case, no punctuation at the end. ' +
  '"text" is the full message to send, one or two sentences, in the same language as the developer\'s last message. ' +
  'Make each a concrete, useful next step that follows from the exchange; never repeat what was just done.'

// What the small model is shown: the last exchange, trimmed, and the changes.
export const aiPrompt = (prompt: string, answer: string, summary: TurnSummary | null, git: GitState | null): string =>
  [
    `Developer's last message:\n${clip(prompt.trim(), 1500)}`,
    `Assistant's reply:\n${clip(answer.trim(), 2500)}`,
    `Files changed this turn: ${summary === null || summary.files.length === 0 ? 'none' : summary.files.map(f => f.name).join(', ')}`,
    `Git: ${git === null ? 'not a repository' : `branch ${git.branch}, ${git.changed} files with uncommitted changes`}`,
  ].join('\n\n')

// The model's reply as chips, or none when it is not the JSON asked for.
export const parseAi = (reply: string): Suggestion[] => {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')

  if (start < 0 || end <= start) {
    return []
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed
    .filter(
      (item): item is { label: string; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { label?: unknown }).label === 'string' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map(item => ({
      label: clip(item.label.trim().replace(/\s+/g, ' '), 28),
      text: clip(item.text.trim(), 400),
      source: 'ai' as const,
    }))
    .filter(s => s.label !== '' && s.text !== '')
    .slice(0, MAX_SUGGESTIONS)
}
