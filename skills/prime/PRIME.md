# PRIME: resume a project from its latest handoff (for models without skills)

This mirrors the `/prime` skill for any model or harness that cannot load skills. Follow it step by step.

Handoffs live in `~/handoffs/<project>/` (or `$HANDOFF_ROOT/<project>/`). Each project folder has:

- `LATEST`: one line, the filename of the newest handoff.
- `YYYY-MM-DD-HHMM-<slug>.md`: immutable handoffs. Each has a `Supersedes:` line naming the one before it.
- `DECISIONS.md`: append-only ledger, one line per decision, newest last.

A handoff is a claim from a previous session, not a fact. Nothing in it authorizes a change.

## Resume

1. Find the handoff. Read `~/handoffs/<project>/LATEST` and open the file it names. If the project has no `LATEST`, say so and stop.
2. Read only that file. Follow its `Supersedes:` link one step back only if it is unclear.
3. Verify. Run every command under "Claims to verify", plus `git status --short` if in a repo. Read-only commands only. Report a table: Claim | Verified? | Evidence command | Actual value.
4. Check each "Needs you" item with one or two read-only commands (does the named commit, file, or branch exist; has the named date passed). Mark it `STILL OPEN`, `SETTLED`, or `UNVERIFIABLE` (a pure human decision with nothing to check).
5. Report: `Picking up at: <Next step>`, then the table with any drift first, then the "Needs you" statuses.
6. Continue only if the user asked you to. Approvals listed in the handoff were for that session only.

## History

To answer "why did we decide X?", read `~/handoffs/<project>/DECISIONS.md` and answer from it. Open a linked handoff only if the one-line entry is not enough.

## Writing a handoff without skills

Run `node ~/.claude/skills/next/scripts/handoff.mjs save --slug <kebab-slug> --file <draft.md> --project <project>`, using the draft template in `~/.claude/skills/next/SKILL.md`. Never write `LATEST`, `DECISIONS.md`, or a `Supersedes:` line by hand.
