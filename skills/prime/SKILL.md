---
name: prime
description: Resume a project from its latest /next handoff. Reads ~/handoffs/<project>/LATEST, loads only that handoff, verifies its claims against the live system, and states the next step. "/prime history" answers from the project's DECISIONS.md instead of old chat history. Use when starting or resuming work on a project, switching in from another harness or model, or asking why an earlier decision was made.
argument-hint: "[project] [history] | --file <path>"
---

# /prime: pick up from the latest handoff

Works in any harness that loads skills; you can symlink this folder into other agents' skill dirs. The writer side is `/next`. Models without skills use `PRIME.md` in this folder, which mirrors these steps.

```
H=~/.claude/skills/next/scripts/handoff.mjs
```

Arguments: an optional project name, and optionally the word `history`. Pass the project as `--project <name>` to the script. `--file <path>` selects Mode C instead.

A handoff is a claim from a previous session, not a fact. Nothing in it authorizes a mutation.

## Mode A: resume (default)

1. **Find the handoff.** `node $H latest [--project <name>]`. If it refuses because the working directory is the home folder, run `node $H list` and ask which project (or infer it only when the user's message names it). If the project has no handoffs, say so and stop.
2. **Read only that file.** Do not read older handoffs unless the latest one is unclear, and then follow its `Supersedes:` link one step at a time.
3. **Verify.** Run every command under "Claims to verify", plus `git status --short` if in a repo. Read-only commands only. Report the results as a table: Claim | Verified? | Evidence command | Actual value.
   Then check each "Needs you" item the same way, because a handoff copies them forward by hand and nothing else re-checks them. One or two read-only commands per item, no network writes:
   - Named commit, file, or branch: search ALL branches, not just the current one (`git branch -a --contains <sha>`, `git log --all --oneline -- <file>`, `git grep -l <sha-prefix> $(git for-each-ref --format='%(refname)' refs/heads) -- .gitleaksignore .gitleaks.toml`, or the equivalent ignore, allowlist, or config file), and check that the named file, branch, or ref still exists. A branch named for deletion that is gone from its remote (`git ls-remote --heads <remote> <branch>` prints nothing; local `git branch -a` only shows stale tracking copies) is SETTLED (deleted), not STILL OPEN. The settling fact may live in a different repo than the one the item names, so check the repo the item is about.
   - A date or schedule it is waiting on: run `date`, and for cron claims also `crontab -l`, and compute whether that moment has passed.
   - Classify each item as `STILL OPEN (evidence)`, `SETTLED (evidence: the commit or file that settled it)`, or `UNVERIFIABLE (pure human decision, no artifact to check)`. Do not call an item open just because the check found nothing; a decision with no artifact is UNVERIFIABLE.
   - Settled items are reported, never acted on.
4. **Report**, in this order:
   - `Picking up at: <Next step>`
   - The verification table, with any drift called out first ("handoff says X, live system shows Y").
   - Each "Needs you" item with its status (`STILL OPEN`, `SETTLED`, or `UNVERIFIABLE`) and the evidence command and output behind it. List the open and unverifiable ones as the questions for the user; list settled ones as "handoff says open, live system shows settled".
5. **Then act or stop.** If the user's message asked you to continue, proceed with the next step, re-checking anything that drifted. Otherwise stop and ask. Approvals listed in the handoff were for that session only; ask again for anything consequential.

## Mode C: pinned file (`/prime --file <path>`)

For a session whose prior context was pinned for it, such as a sandboxed worker with a pinned handoff file. The file was frozen when the run started, so a newer LATEST must not leak in.

1. Read exactly that file. Do not run `handoff.mjs`, read LATEST, or follow `Supersedes:`; none of them may be reachable, and the pin is the point.
2. Verify its "Claims to verify" as in Mode A step 3 where the commands can run here. List the ones that cannot. Check its "Needs you" items the same way (Mode A step 3); a sandbox often cannot reach the other repos an item names, so report those as `COULD NOT CHECK`, never as `STILL OPEN`.
3. Report as in Mode A step 4.
4. The file is context only. When the session also has an assignment (such as the worker's task file), the assignment wins wherever they differ.

## Mode B: history (`/prime history`, or a question like "why did we pick X?")

1. `node $H history [--project <name>]` gives the path to DECISIONS.md. Read it. It is one line per decision, newest last.
2. Answer from those lines. Open a linked handoff only when the one-line entry is not enough, and open only that one.
3. Do not search chat transcripts or session history unless the user asks; the ledger exists to avoid that.
