// Pure SVG builders for the band and the context pane. Nothing here touches
// `$`: register.tsx reads the state and hands plain values in.

import type { Activity, Breakdown, Limit, StepKind, TurnSummary } from '../types'

export type Tone = 'primary' | 'tertiary' | 'error'

const WARN_AT = 60
const ALERT_AT = 85

export const toneOf = (percent: number | undefined): Tone =>
  percent === undefined || percent < WARN_AT
    ? 'primary'
    : percent < ALERT_AT
      ? 'tertiary'
      : 'error'

// 1 decimal where it says something (12.3k, 1.5M), none where it is .0.
const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)))

export const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${trim(n / 1_000_000, 1)}M`
    : n >= 1000
      ? `${trim(n / 1000, n >= 100_000 ? 0 : 1)}k`
      : `${n}`

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  const m = Math.floor(s / 60)

  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const formatReset = (resetsAt: string | undefined, now: number): string | undefined => {
  if (resetsAt === undefined) {
    return undefined
  }

  const left = Date.parse(resetsAt) - now

  if (!Number.isFinite(left)) {
    return undefined
  }

  if (left <= 0) {
    return 'resets now'
  }

  const h = Math.floor(left / 3_600_000)
  const d = Math.floor(h / 24)

  return d > 0 ? `resets in ${d}d ${h % 24}h` : h > 0 ? `resets in ${h}h` : `resets in ${Math.max(1, Math.round(left / 60_000))}m`
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'Spend',
}

export const limitName = (kind: string): string => LIMIT_NAMES[kind] ?? kind.slice(0, 4)

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Cut a label to about `chars` characters, keeping its start.
const fit = (text: string, chars: number): string =>
  text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`

// M3 baseline roles, chosen to read on the band's tinted surface container.
// Per tone: accent (arcs, dots, glyphs), the badge's fill, the badge's text.
// Light badges are filled with the role itself, as a pale container would
// melt into the tinted card; dark ones keep the container tone. Tracks are
// outline-variant (a step lighter in dark), and icons sit on the lowest
// surface. Light, then dark.
const PALETTE = {
  light: {
    on: '#1D1B20',
    onVariant: '#49454F',
    track: '#CAC4D0',
    lowest: '#FFFFFF',
    primary: ['#6750A4', '#6750A4', '#FFFFFF'],
    tertiary: ['#7D5260', '#7D5260', '#FFFFFF'],
    error: ['#B3261E', '#B3261E', '#FFFFFF'],
  },
  dark: {
    on: '#E6E0E9',
    onVariant: '#CAC4D0',
    // A step above outline-variant: the card's lifted blue-gray needs it.
    track: '#5B5866',
    lowest: '#0F0D13',
    primary: ['#D0BCFF', '#4F378B', '#EADDFF'],
    tertiary: ['#EFB8C8', '#633B48', '#FFD8E4'],
    error: ['#F2B8B5', '#8C1D18', '#F9DEDC'],
  },
} as const

const TONES: readonly Tone[] = ['primary', 'tertiary', 'error']

const vars = (scheme: 'light' | 'dark'): string => {
  const p = PALETTE[scheme]
  const roles = TONES.flatMap(tone => {
    const [accent, container, onContainer] = p[tone]

    return [`--${tone}:${accent}`, `--${tone}-c:${container}`, `--${tone}-on-c:${onContainer}`]
  })

  return [
    `--lowest:${p.lowest}`,
    `--on:${p.on}`,
    `--on-variant:${p.onVariant}`,
    `--track:${p.track}`,
    ...roles,
  ].join(';')
}

const BASE_STYLE = `svg { ${vars('light')}; font-family: 'Google Sans Flex', 'Google Sans', 'Roboto Flex', Roboto, system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { svg { ${vars('dark')}; } }
${TONES.map(
  tone =>
    `.tone-${tone} { --accent: var(--${tone}); --container: var(--${tone}-c); --on-container: var(--${tone}-on-c); }`,
).join('\n')}`

const svgOpen = (w: number, h: number, extraClass = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"${extraClass === '' ? '' : ` class="${extraClass}"`} width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMid meet">`

// ---------------------------------------------------------------- the badge

export const BADGE = 64
const BC = BADGE / 2
const R = 25
const POINTS = 72

const shape = (radius: (t: number) => number): string => {
  const points: string[] = []

  for (let i = 0; i < POINTS; i += 1) {
    const t = (i / POINTS) * Math.PI * 2
    const r = radius(t)
    points.push(`${(BC + r * Math.cos(t)).toFixed(2)} ${(BC + r * Math.sin(t)).toFixed(2)}`)
  }

  return `M ${points.join(' L ')} Z`
}

const lobed = (lobes: number, depth: number, phase = 0) => (t: number) =>
  R + depth * Math.cos(lobes * (t + phase))
const oval = (a: number, b: number) => (t: number) =>
  (a * b) / Math.sqrt((b * Math.cos(t)) ** 2 + (a * Math.sin(t)) ** 2)

// The resting badge: the M3 Expressive 9-sided cookie.
const COOKIE = shape(lobed(9, 1.8))

// The loading indicator's cycle, after M3 Expressive's.
const MORPHS = [
  shape(lobed(10, 3)),
  shape(lobed(9, 1.8)),
  shape(lobed(5, 2.4, Math.PI / 10)),
  shape(oval(R + 2, R - 8)),
  shape(lobed(8, 2.8, Math.PI / 8)),
  shape(lobed(4, 3.6, Math.PI / 4)),
  shape(oval(R - 1, R - 4)),
]

const MORPH_KEYFRAMES = (() => {
  const steps = [...MORPHS, MORPHS[0]]
  const frames = steps.map((d, i) => {
    const at = ((i / (steps.length - 1)) * 100).toFixed(2)

    return `${at}% { d: path('${d}'); animation-timing-function: cubic-bezier(0.42, 1.67, 0.21, 0.9); }`
  })

  return `@keyframes morph { ${frames.join(' ')} }`
})()

// The context percent in the cookie; it morphs while a turn runs. Its source
// changes only with the percent and the state, so it is not redrawn (and its
// animation not restarted) on every tool call.
export const badgeScene = (percent: number | undefined, isWorking: boolean): string => {
  const tone = toneOf(percent)
  const figure =
    percent === undefined
      ? `<text x="${BC}" y="${BC + 6}" text-anchor="middle" class="num">–</text>`
      : `<text x="${BC}" y="${BC + 6}" text-anchor="middle" class="num">${Math.round(percent)}<tspan class="pct">%</tspan></text>`

  return `${svgOpen(BADGE, BADGE, isWorking ? 'busy' : '')}
<style>
${BASE_STYLE}
.spin { transform-box: view-box; transform-origin: ${BC}px ${BC}px; animation: spin 18s linear infinite; }
.badge { fill: var(--container); }
.busy .spin { animation-duration: 2.8s; }
.busy .badge { animation: morph 4.9s infinite; }
.num { fill: var(--on-container); font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
.pct { font-size: 11px; font-weight: 600; }
@keyframes spin { to { transform: rotate(360deg); } }
${MORPH_KEYFRAMES}
@media (prefers-reduced-motion: reduce) { .spin, .badge { animation: none; } }
</style>
<g class="tone-${tone}"><g class="spin"><path class="badge" d="${COOKIE}"/></g>${figure}</g>
</svg>`
}

// --------------------------------------------------------------- the icons

// Glyphs drawn about (0, 0) in a 16-unit box, stroked in the icon's color.
const GLYPHS: Record<StepKind | 'think', string> = {
  read: '<path d="M -7 0 Q 0 -6.5 7 0 Q 0 6.5 -7 0 Z"/><circle cx="0" cy="0" r="2.2" class="fill"/>',
  edit: '<path d="M -5.5 5.5 L -5.5 2.5 L 3 -6 L 6 -3 L -2.5 5.5 Z"/><path d="M 1 -4 L 4 -1"/>',
  run: '<path d="M -6.5 -4.5 L -2 0 L -6.5 4.5"/><path d="M 0 5 L 6.5 5"/>',
  search: '<circle cx="-1.5" cy="-1.5" r="4.8"/><path d="M 2 2 L 6.5 6.5"/>',
  web: '<circle cx="0" cy="0" r="6.5"/><ellipse cx="0" cy="0" rx="2.8" ry="6.5"/><path d="M -6.5 0 L 6.5 0"/>',
  agent: '<path class="fill" d="M 0 -7 Q 1 -1 7 0 Q 1 1 0 7 Q -1 1 -7 0 Q -1 -1 0 -7 Z"/>',
  plan: '<path d="M -2 -4.5 L 6.5 -4.5 M -2 0 L 6.5 0 M -2 4.5 L 6.5 4.5"/><circle cx="-5.5" cy="-4.5" r="1.1" class="fill"/><circle cx="-5.5" cy="0" r="1.1" class="fill"/><circle cx="-5.5" cy="4.5" r="1.1" class="fill"/>',
  other: '<circle cx="0" cy="0" r="3" class="fill"/>',
  think: '<circle class="fill t1" cx="-5" cy="0" r="1.9"/><circle class="fill t2" cx="0" cy="0" r="1.9"/><circle class="fill t3" cx="5" cy="0" r="1.9"/>',
}

const icon = (kind: StepKind | 'think', cx: number, cy: number): string =>
  `<circle cx="${cx}" cy="${cy}" r="16" class="icon-bg"/><g class="glyph" transform="translate(${cx} ${cy})">${GLYPHS[kind]}</g>`

// ---------------------------------------------------- the live activity line

// A timer that counts up by itself: digit strips stepped by CSS, started
// `elapsed` seconds in by a negative delay, so the band need not redraw.
const timer = (right: number, baseline: number, elapsed: number): string => {
  const line = 20
  const sTop = baseline - 15
  const seconds = Array.from(
    { length: 60 },
    (_, i) => `<text x="0" y="${15 + i * line}">${String(i).padStart(2, '0')}</text>`,
  ).join('')
  const minutes = Array.from(
    { length: 100 },
    (_, i) => `<text x="30" y="${15 + i * line}" text-anchor="end">${i}</text>`,
  ).join('')

  return `<svg x="${right - 18}" y="${sTop}" width="20" height="${line}"><g class="ss" style="animation-delay: -${elapsed}s">${seconds}</g></svg>
<text x="${right - 20}" y="${baseline}" text-anchor="end" class="clock">:</text>
<svg x="${right - 54}" y="${sTop}" width="31" height="${line}"><g class="mm" style="animation-delay: -${elapsed}s">${minutes}</g></svg>`
}

export const ACTIVITY_H = 56

export const activityScene = (activity: Activity, elapsed: number, tone: Tone, w: number): string => {
  const current = activity.current
  const label = current === undefined ? 'Thinking' : current.label
  const chars = Math.floor((w - 48 - 70) / 8)
  const shown = activity.steps.slice(-Math.max(4, Math.floor((w - 48 - 120) / 10)))
  const dots = shown
    .map((kind, i) => {
      const isLast = i === shown.length - 1 && current !== undefined

      return `<circle cx="${48 + i * 10}" cy="44" r="3.2" class="${isLast ? 'dot now' : 'dot'}"/>`
    })
    .join('')
  const countX = 48 + shown.length * 10 + (shown.length > 0 ? 4 : 0)

  return `${svgOpen(w, ACTIVITY_H)}
<style>
${BASE_STYLE}
.icon-bg { fill: var(--lowest); }
.glyph { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.glyph .fill { fill: var(--accent); stroke: none; }
.label { fill: var(--on); font-size: 15px; font-weight: 600; }
.clock, .ss text, .mm text { fill: var(--on-variant); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.meta { fill: var(--on-variant); font-size: 11.5px; font-weight: 500; }
.dot { fill: var(--accent); opacity: 0.45; }
.dot.now { opacity: 1; transform-box: fill-box; transform-origin: center; animation: pulse 1.2s ease-in-out infinite; }
.ss { animation: tick-s 60s steps(60) infinite; }
.mm { animation: tick-m 6000s steps(100) infinite; }
.t1, .t2, .t3 { animation: blink 1.2s ease-in-out infinite; }
.t2 { animation-delay: 0.2s; }
.t3 { animation-delay: 0.4s; }
@keyframes tick-s { to { transform: translateY(-1200px); } }
@keyframes tick-m { to { transform: translateY(-2000px); } }
@keyframes pulse { 50% { transform: scale(1.45); } }
@keyframes blink { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .dot.now, .t1, .t2, .t3 { animation: none; } }
</style>
<g class="tone-${tone}">
${icon(current === undefined ? 'think' : current.kind, 16, 26)}
<text x="48" y="24" class="label">${esc(fit(label, chars))}</text>
${timer(w - 4, 24, elapsed)}
${dots}
<text x="${countX}" y="48" class="meta">${activity.count === 1 ? '1 step' : `${activity.count} steps`}</text>
</g>
</svg>`
}

// ------------------------------------------------------ the last-turn line

// Taller than its text: the room under the line keeps it off the chips.
export const SUMMARY_H = 32

export const summaryScene = (last: TurnSummary | null, tone: Tone, w: number): string => {
  const head =
    last === null ? 'Ready' : last.isAborted ? `Stopped after ${formatDuration(last.durationMs)}` : `Last turn ${formatDuration(last.durationMs)}`
  const parts =
    last === null
      ? ['No turns yet in this session']
      : [
          last.tools === 0 ? 'no tools' : last.tools === 1 ? '1 tool' : `${last.tools} tools`,
          last.files.length === 0 ? 'no files changed' : last.files.length === 1 ? '1 file' : `${last.files.length} files`,
          ...(last.tokensIn === undefined
            ? []
            : [`${formatTokens(last.tokensIn)} in · ${formatTokens(last.tokensOut ?? 0)} out`]),
        ]

  return `${svgOpen(w, SUMMARY_H)}
<style>
${BASE_STYLE}
.head { fill: var(--on); font-size: 15px; font-weight: 600; }
.meta { fill: var(--on-variant); font-size: 13px; font-weight: 500; }
.mark { fill: var(--accent); }
</style>
<g class="tone-${tone}">
<circle cx="6" cy="13" r="4" class="mark"/>
<text x="18" y="18"><tspan class="head">${esc(head)}</tspan><tspan class="meta" dx="10">${esc(parts.join(' · '))}</tspan></text>
</g>
</svg>`
}

// --------------------------------------------------------- the limit rings

export const RING_W = 140
export const RING_H = 64

export const ringScene = (limit: Limit, now: number): string => {
  const p = Math.min(1, Math.max(0, limit.percentUsed / 100))
  const r = 14
  const c = 2 * Math.PI * r
  const cx = 22
  const cy = 32
  const reset = formatReset(limit.resetsAt, now)
  const arc =
    p > 0.005
      ? `<circle class="arc" cx="${cx}" cy="${cy}" r="${r}" stroke-dasharray="${(c * p).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : ''

  return `${svgOpen(RING_W, RING_H)}
<style>
${BASE_STYLE}
.ring { fill: none; stroke: var(--track); stroke-width: 5; }
.arc { fill: none; stroke: var(--accent); stroke-width: 5; stroke-linecap: round; }
.rv { fill: var(--on); font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.rk { fill: var(--on-variant); font-size: 12px; font-weight: 500; }
.rr { fill: var(--on-variant); font-size: 11px; font-weight: 500; }
</style>
<g class="tone-${toneOf(limit.percentUsed)}">
<circle class="ring" cx="${cx}" cy="${cy}" r="${r}"/>${arc}
<text x="46" y="${reset === undefined ? 37 : 30}"><tspan class="rk">${esc(limitName(limit.kind))}</tspan><tspan class="rv" dx="5">${Math.round(limit.percentUsed)}%</tspan></text>
${reset === undefined ? '' : `<text x="46" y="47" class="rr">${esc(reset)}</text>`}
</g>
</svg>`
}

// A window the account has no limit on (5h on Ultra): an empty ring holding ∞.
export const unlimitedRingScene = (kind: string): string => {
  const cx = 22
  const cy = 32

  return `${svgOpen(RING_W, RING_H)}
<style>
${BASE_STYLE}
.ring { fill: none; stroke: var(--track); stroke-width: 5; }
.inf { fill: var(--accent); font-size: 17px; font-weight: 600; }
.rv { fill: var(--on); font-size: 15px; font-weight: 650; }
.rk { fill: var(--on-variant); font-size: 12px; font-weight: 500; }
.rr { fill: var(--on-variant); font-size: 11px; font-weight: 500; }
</style>
<g class="tone-primary">
<circle class="ring" cx="${cx}" cy="${cy}" r="14"/>
<text x="${cx}" y="${cy + 6}" text-anchor="middle" class="inf">∞</text>
<text x="46" y="30"><tspan class="rk">${esc(limitName(kind))}</tspan><tspan class="rv" dx="5">∞</tspan></text>
<text x="46" y="47" class="rr">No limit</text>
</g>
</svg>`
}

// -------------------------------------------------- the context pane's bar

// Category colors for the pane, mid tones that read on light and dark.
export const SLICE_COLORS = ['#8E7CC3', '#C48A9C', '#7E8CC8', '#6FB3A6', '#D9A35B', '#A08FB8', '#B07FB0', '#7FA6C4']
export const FREE_COLOR = '#9E98A8'

export const sliceColor = (index: number): string => SLICE_COLORS[index % SLICE_COLORS.length] ?? '#8E7CC3'

// The window as one M3 segmented bar with its legend beneath, drawn inline in
// the band: a header line, a pill per used category then free space, the
// auto-compact point as a tick, and a legend of name, tokens and share.
const LEGEND_COL = 220
const LEGEND_ROW = 20

export const breakdownScene = (b: Breakdown, w: number): { svg: string; height: number } => {
  const x0 = 2
  const x1 = w - 2
  const gap = 4
  const usable = x1 - x0
  const used = b.slices.filter(s => s.tokens > 0)
  const free = Math.max(0, b.max - used.reduce((sum, s) => sum + s.tokens, 0))
  const parts = [
    ...used.map((s, i) => ({ name: s.name, tokens: s.tokens, color: sliceColor(i), isFree: false })),
    { name: 'Free space', tokens: free, color: FREE_COLOR, isFree: true },
  ]
  const total = parts.reduce((sum, part) => sum + part.tokens, 0) || 1
  const room = usable - gap * (parts.length - 1)
  const pct = (n: number): string => `${b.max === 0 ? 0 : Math.round((n / b.max) * 100)}%`
  const barY = 26
  let x = x0
  const pills = parts
    .map(part => {
      const width = Math.max(3, (part.tokens / total) * room)
      const pill = `<rect x="${x.toFixed(1)}" y="${barY}" width="${width.toFixed(1)}" height="14" rx="${Math.min(7, width / 2).toFixed(1)}" ${part.isFree ? 'class="free"' : `fill="${part.color}"`}/>`
      x += width + gap

      return pill
    })
    .join('')
  const hasTick = b.compactAt !== undefined && b.max > 0
  const tick = hasTick
    ? (() => {
        const tx = x0 + ((b.compactAt ?? 0) / b.max) * usable

        return `<rect x="${(tx - 1.5).toFixed(1)}" y="${barY - 5}" width="3" height="24" rx="1.5" class="tick"/><text x="${tx.toFixed(1)}" y="${barY + 32}" text-anchor="middle" class="tl">Auto-compact</text>`
      })()
    : ''
  const cols = Math.max(1, Math.floor(w / LEGEND_COL))
  const legendY = barY + (hasTick ? 52 : 34)
  const legend = parts
    .map((part, i) => {
      const lx = (i % cols) * LEGEND_COL + 6
      const ly = legendY + Math.floor(i / cols) * LEGEND_ROW

      return `<circle cx="${lx}" cy="${ly - 4}" r="4" ${part.isFree ? 'class="free"' : `fill="${part.color}"`}/><text x="${lx + 10}" y="${ly}" class="ln">${esc(fit(part.name, 20))}</text><text x="${lx + LEGEND_COL - 16}" y="${ly}" text-anchor="end" class="lv">${formatTokens(part.tokens)} · ${pct(part.tokens)}</text>`
    })
    .join('')
  const height = legendY + Math.ceil(parts.length / cols) * LEGEND_ROW - 8
  const meta = [b.model, b.compactAt === undefined ? undefined : `auto-compacts at ${formatTokens(b.compactAt)}`]
    .filter(Boolean)
    .join(' · ')

  return {
    height,
    svg: `${svgOpen(w, height)}
<style>
${BASE_STYLE}
.hd { fill: var(--on); font-size: 13px; font-weight: 600; }
.hm { fill: var(--on-variant); font-size: 12px; font-weight: 500; }
.tick { fill: var(--on); opacity: 0.7; }
.tl { fill: var(--on-variant); font-size: 10px; font-weight: 500; }
.free { fill: var(--track); }
.ln { fill: var(--on); font-size: 12px; font-weight: 500; }
.lv { fill: var(--on-variant); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
</style>
<text x="${x0}" y="14"><tspan class="hd">${formatTokens(b.total)} of ${formatTokens(b.max)} used</tspan><tspan class="hm" dx="8">${esc(meta)}</tspan></text>
${pills}
${tick}
${legend}
</svg>`,
  }
}

// ------------------------------------------------------------------ the card

// The band's one M3 container is drawn here rather than by a Box, so it has
// rounded corners and a color per mode: the band lays it behind its content,
// which carries its own spacing in pixels so the card's height is known.
export const ROW_H = 80
export const PAD_X = 16
export const CARD_BOTTOM = 12

// A tone of the surface-container family with a little blue: near-white in
// light mode, a quiet lift over the page in dark mode.
const CARD_LIGHT = '#EEF3FC'
const CARD_DARK = '#232731'

export const cardScene = (w: number, h: number): string =>
  `${svgOpen(w, h)}
<style>
.card { fill: ${CARD_LIGHT}; }
@media (prefers-color-scheme: dark) { .card { fill: ${CARD_DARK}; } }
</style>
<rect class="card" x="0" y="0" width="${w}" height="${h}" rx="24"/>
</svg>`

// Places a scene inside a larger frame at (x, y): the frame's empty part is
// the spacing around it, drawn in pixels.
export const inset = (inner: string, w: number, h: number, x: number, y: number): string =>
  `${svgOpen(w, h)}${inner.replace('<svg xmlns="http://www.w3.org/2000/svg"', `<svg x="${x}" y="${y}"`)}</svg>`
