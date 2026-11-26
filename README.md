# m3-session

A Claude Code mod that puts a **Material 3 Expressive** session band above the prompt.

**While Claude works**
- The step running now, in words: *Editing register.tsx*, *Running npm test*, *Searching for describe(*, with an M3 icon for its kind.
- A timer for the turn that counts up by itself, and a trail of the turn's steps (the running one pulses).
- The cookie badge holds the context percent and morphs through the M3 Expressive loading-indicator shapes.

**When a turn ends**
- How long it took, how many tools it called, and how many files it changed.
- A chip per changed file with its `+/−` lines against `HEAD` (press to copy the path), and a git chip with the branch and how many files are changed (press to copy the branch).
- A **Context** chip that unfolds the context window by category right in the band: an M3 segmented bar, a legend with tokens and shares, and where auto-compaction runs. Press it again (*Hide context*) to fold it away.

**Always**
- Rate-limit rings with how long until each window resets. On a plan with no 5-hour limit (such as Ultra), the 5h ring shows ∞.
- Light and dark follow the app; *reduce motion* is respected. The terminal gets a text version.

The band follows the main conversation: subagents' own tool calls are not shown step by step. Git is read once when a turn ends, never polled; the context breakdown is the local `/context` estimate and makes no API calls.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install m3-session --marketplace LinusAuditore/claude-m3-session
```

From a shell:

```bash
claude plugin install m3-session --marketplace LinusAuditore/claude-m3-session
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `LinusAuditore/claude-m3-session`, then **Add plugin**.

## Notes

- On desktop the band's pixel width is estimated from its column count (8.4 px per column). If it stops short of, or runs past, the edge on your setup, adjust `ADVANCE` in `hooks/register.tsx`.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
