# claude-mods

Claude Code mods (function-hooks plugins) and skills. Each mod lives in its own folder with a `.claude-plugin/plugin.json`; mods with a README explain their options there.

| Folder | What it does |
| --- | --- |
| `artifact-watchdog` | Watches each Agent dispatch's report file and flags a 5-minute stall |
| `auto-handoff` | Writes a `/next` handoff automatically once a long session crosses a token threshold |
| `flight-recorder` | Live timeline of model requests, tool calls and subagents in a turn |
| `jev-tool-gate` | Log-only judgment of risky tool calls; never changes a decision |
| `next-steps` | Suggests up to three next prompts after each turn |
| `prompt-cache-control` | Prompt-cache meter and expiry countdown above the prompt |
| `skills/next`, `skills/prime` | Session handoff skills, see below |

## Skills: /next and /prime

`/next` ends a session by writing an immutable handoff (Where we are / What we decided / Next step) to `~/handoffs/<project>/`, moving a `LATEST` pointer, and appending each decision to the project's `DECISIONS.md`. `/prime` starts the next session from that handoff: it reads only the latest one, re-checks its claims against the live system, and states the next step. `/prime history` answers "why did we decide X?" from the decisions ledger.

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
