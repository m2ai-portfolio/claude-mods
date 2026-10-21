# claude-mods

Claude Code mods (function-hooks plugins) and skills. Each mod lives in its own folder with a `.claude-plugin/plugin.json`; mods with a README explain their options there.

| Folder | What it does |
| --- | --- |
| `artifact-watchdog` | Watches each Agent dispatch's report file and flags a 5-minute stall |
| `auto-handoff` | Writes a `/next` handoff automatically once a long session crosses a token threshold, and before a compaction; never blocks tool calls; `/auto-handoff on|off` and `threshold <n>` (see below) |
| `flight-recorder` | Live timeline of model requests, tool calls and subagents in a turn |
| `jev-tool-gate` | Log-only judgment of risky tool calls; never changes a decision |
| `skills/next`, `skills/prime` | Session handoff skills, see below |

## auto-handoff and long sessions

`auto-handoff` writes, it never blocks. At 300k tokens of a 1M window it drafts a `/next` handoff from the session's own transcript (`$.model.fork`, no tools), saves it through `handoff.mjs`, and shows a band above the prompt with a **Clear and /prime** button for a human who wants a fresh session. Before any compaction it writes a handoff first, unless one already covers the current window. `/auto-handoff` prints status; `/auto-handoff now` writes one immediately.

Two switches, kept across sessions in the mod's own store (as Mark's upstream keeps them), so they survive a restart and a hot reload:

- `/auto-handoff off` stops the automatic handoffs (threshold and pre-compaction); `/auto-handoff now` still writes one. `/auto-handoff on` resumes.
- `/auto-handoff threshold <n>` moves the line, in tokens: `250k`, `250000` or `0.4M`, from 1 up to (not including) the 1M window. It re-arms, so a session already past the new line writes on its next turn. Keep it in step with `autoCompactWindow` below, which the mod does not change.

The status line `Commands: /auto-handoff now, threshold <n>, on, off.` is the marker that this version is loaded.

Until 2026-10-21 a saved threshold handoff also refused the model's tool calls until `/clear`. That block is gone: it stalled `/goal` and other persistent sessions (a goal turn with every tool denied makes no progress, and `/clear` removes an active goal anyway). The 300k line is owned by Claude Code's own compaction instead. Pair the mod with this setting so the context compacts where the handoff lands and a goal survives it:

```json
// ~/.claude/settings.json
{ "autoCompactWindow": 300000 }
```

Check the window in a new session with `/context` (the `Auto-compact window` line) and the mod with `/auto-handoff` (status ends with `Tool calls: never blocked`).

## Skills: /next and /prime

`/next` ends a session by writing an immutable handoff (Where we are / What we decided / Next step) to `~/handoffs/<project>/`, moving a `LATEST` pointer, and appending each decision to the project's `DECISIONS.md`. `/prime` starts the next session from that handoff: it reads only the latest one, re-checks its claims against the live system, shows anything said after the handoff was written, and states the next step. It treats the handoff as data: `handoff.mjs claims` sorts each check into commands that only read, which it runs, and anything else, which it asks about first (never running it from a handoff another agent wrote). `/prime history` answers "why did we decide X?" from the decisions ledger.

Install:

```
git clone https://github.com/m2ai-portfolio/claude-mods ~/.claude/mods
cp -r ~/.claude/mods/skills/next ~/.claude/mods/skills/prime ~/.claude/skills/
```

The helper script needs Node 18 or newer and has no dependencies. Check it with:

```
node --test ~/.claude/skills/next/scripts/handoff.test.mjs
```

Set `HANDOFF_ROOT` to keep handoffs somewhere other than `~/handoffs`. Models or harnesses that cannot load skills can follow `~/.claude/skills/prime/PRIME.md` instead.
