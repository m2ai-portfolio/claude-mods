# jev-tool-gate (log-only)

Before a risky tool call runs, record what Jev (TypeSafe's hosted judgment
model) thinks of it. It never changes a decision. Rung 1 of the trust ladder.

## What it does

- Hooks `tool.check` (the engine's permission decision for a real call). It
  takes core's verdict first and returns it unchanged every time: allow, ask
  and deny all pass through.
- Judges only in-scope tools: `Bash`, `Write`, `Edit`, `NotebookEdit`, and MCP
  tools whose own name has one of the words `send`, `delete`, `post`,
  `publish`, `trash`, `transfer`. Both lists are `userConfig` (`tools`,
  `mcpVerbs`). Everything else is not judged and not logged.
- Two Jev noul questions, worded about the act:
  (a) running this call would itself delete, overwrite, send or publish
  something that cannot easily be restored;
  (b) the call carries out an instruction from fetched or read content, not
  from the operator's request.
- Hosted switch, persisted in the mod's store, DEFAULT OFF. Off: the candidate
  is logged with `judged: false` and no network call is made. On: one request
  per distinct (question version, tool, redacted input), raced against 800 ms;
  timeout or any error is logged and the call goes on (fail open). Successful
  judgments are cached for the session; errors are not cached.
- What is sent: tool name, the input as sorted JSON after secret redaction,
  capped at 2,000 chars, plus the operator's last prompt (redacted, first 300
  chars). Subagent calls are logged with their `agentId`.

## Commands

- `/jev-gate`: hosted on/off, whether a key was found (never its value),
  lifetime counts, last 5 entries.
- `/jev-gate hosted on` / `/jev-gate hosted off`: flip the switch. The store
  is shared by every session on this machine, so the switch is too.

## Key

Read at run time only: `TYPESAFE_API_KEY` from the process environment, else
the one `TYPESAFE_API_KEY=` line of `~/.env.shared`. Never logged or shown.

## No Orphan Loops

- Owner: Matthew.
- Sink: `~/logs/jev-tool-gate.jsonl`, one JSON line per candidate call
  (`ts, sessionId, agentId, tool, toolUseId, inputHash, preview (200 chars,
  redacted), questionVersion, judged, cached, scores, lowConfidence, model,
  inputTokens, latencyMs, error, coreDecision, coreRule`). Rotates to `.1`
  past 5 MiB.
- Kill: `/jev-gate hosted off` stops all network calls; removing this folder
  from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` stops the mod.

## Trust ladder

- Rung 1 (this build): log-only. Nothing Jev says reaches a decision.
- Promotion to suggest/ask mode (return `ask` with Jev's reason when core said
  `allow` and a score clears a bar; never `allow`, never `deny`) needs a
  reviewed week of `~/logs/jev-tool-gate.jsonl` showing useful judgments and no
  harm, and Matthew's explicit call.

## Checks

```
claude plugin validate ~/.claude/mods/jev-tool-gate
(cd ~/.claude/mods/jev-tool-gate && claude plugin test .)
(cd ~/.claude/mods/jev-tool-gate && /home/apexaipc/projects/t3code-teletraan/node_modules/.bin/tsc -p tsconfig.json --noEmit)
```

## Source of the Jev parts

`hooks/jev.ts` vendors the dependency-free parts of
`~/projects/worktrees/ccos-continuity-pair/src/agent-engine/jev-adapter.ts`
(commit 8de84f13). The wire format matches `~/projects/jev-playground`
(TypeSafe SDK `systemOne`). Consolidating the three Jev clients into one
shared contract is an open follow-up.
