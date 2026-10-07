---
name: next
description: End-of-session handoff. Writes an immutable handoff (Where we are / What we decided / Next step) to ~/handoffs/<project>/, moves the LATEST pointer, and appends decisions to the project's DECISIONS.md so any harness (Claude Code, Codex, local model) can resume with /prime. Use when wrapping up a session, switching tools or models, or handing off work.
argument-hint: What will the next session focus on?
---

# /next: write the handoff

Works in any harness that loads skills; you can symlink this folder into other agents' skill dirs. The pickup side is `/prime` (`~/.claude/skills/prime/SKILL.md`), and models without skills use `~/.claude/skills/prime/PRIME.md`.

If the user passed arguments, shape "Next step" around that focus. Do not do the remaining work while writing the handoff.

The helper script owns all bookkeeping. Never write `LATEST`, `DECISIONS.md`, a `Supersedes:` line, or the final filename by hand.

```
H=~/.claude/skills/next/scripts/handoff.mjs
```

## Step 1: Resolve the project

Run `node $H project`. It uses the git root's folder name, or the current folder's name outside git.

If it refuses because the working directory is the home folder, run `node $H list`, pick the existing project this session was about (or coin a short kebab-case name), and pass `--project <name>` to every later call. When unsure which project, ask the user.

## Step 2: Gather state

- From the conversation: completed work, decisions and their reasons, gotchas, remaining work, approvals granted.
- If in a git repo: `git status --short` and `git diff --stat`. Do not commit, reset, or clean to tidy the handoff. (That is for interactive sessions. A sandboxed worker with a pinned handoff file, whose supervisor reads only committed work, must commit all its work, handoff included, and writes the handoff to the path its assignment names instead of running `save`.)
- Running processes or external state only when they affect safe continuation.
- If `node $H latest` returns a previous handoff, skim it so this one does not repeat settled decisions.

## Step 3: Draft

Write the draft to a scratch/temp file (not into `~/handoffs`). Target under 500 words. Use exactly these headings; the first three are required and the script rejects a draft without them:

```markdown
# Handoff: <one-line outcome or active objective>
Date: <YYYY-MM-DD HH:MM with timezone>
Project: <project>
Working directory: <absolute path>
Harness: <Claude Code / Codex / other, plus model>. Session: <id or unknown>

## Where we are
<What is done and verified, and the current state: uncommitted changes, running processes, partial work.>

## What we decided
- <Decision. Why: reason.>
<One bullet per decision made THIS session. Write "- None" if there were none. Each bullet becomes one line in DECISIONS.md, so make it stand alone.>

## Next step
<The single first concrete action for the next session, and why it is next.>

## Remaining
### Ready
<Authorized work that can start immediately.>
### Needs you
<Exact decision, credential, approval, or external event. Where one exists, name the concrete artifact the item waits on (commit, file, branch, or date) so /prime can check whether it is still open. For a schedule or date claim, quote `date` and `crontab -l` output taken now, not from memory.>
### Later
<Non-urgent.>

## Claims to verify
- <A fact the next session depends on> : `<read-only command that checks it>`
<3 to 6 items. /prime runs these before acting. Read-only commands only: test suites and builds write temp files, so /prime may refuse them. Point to the last result under References instead.>

## References
<Absolute paths, commits, issue IDs, plans. Point to detail; do not copy it.>
```

Content rules:
- Mark anything unverified as unverified. Distinguish what you checked from what the user said and from what you assume.
- Approvals do not carry over. List what was granted this session and what still needs approval.
- Never include secrets, tokens, or unnecessary personal data. Use `[REDACTED]`.
- No em dashes.

## Step 4: Save

```
node $H save --slug <2-4-word-kebab-slug> --file <draft path> [--project <name>]
```

It stores `~/handoffs/<project>/YYYY-MM-DD-HHMM-<slug>.md`, adds the `Supersedes:` link, moves `LATEST`, and appends the decision bullets to `DECISIONS.md`. Handoffs are immutable: to correct one after saving, save a new handoff rather than editing the old file.

## Step 5: Return to the user

Print the saved handoff, its path, and the pickup line:

`Next session: open <working directory> and run /prime  (from elsewhere: /prime <project>; model without skills: "Read ~/.claude/skills/prime/PRIME.md and follow it for project <project>")`

## Configuration

- Handoffs live in `~/handoffs/<project>/`. Set `HANDOFF_ROOT` to store them elsewhere.
- The helper is plain Node (no dependencies). Its tests: `node --test ~/.claude/skills/next/scripts/handoff.test.mjs`.
- `save --key <K>` is an idempotent keyed save for automated runs: the draft must carry the line `Attempt-Key: <K>`, and a rerun after a crash repairs `LATEST` and `DECISIONS.md` instead of writing a second handoff.
