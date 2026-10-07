// Run: node --test ~/.claude/skills/next/scripts/handoff.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./handoff.mjs", import.meta.url));

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-test-"));
  const root = path.join(base, "handoffs");
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HANDOFF_ROOT: root, HANDOFF_HOME: home };
  const run = (args, cwd = base, script = SCRIPT) =>
    spawnSync("node", [script, ...args], { cwd, env, encoding: "utf8" });
  return { base, root, home, run };
}

function draft(dir, body) {
  const f = path.join(dir, `draft-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(f, body);
  return f;
}

const GOOD = `# Handoff: avatar cutout
Date: 2026-09-27

## Where we are
Cutout rendered.

## What we decided
- Use Creatify Aurora. Why: best lip sync.
- Remove background locally. Why: free.

## Next step
Composite beats 1 to 5.
`;

test("rejects a draft missing a required section", () => {
  const s = sandbox();
  const f = draft(s.base, GOOD.replace("## Next step", "## Later"));
  const r = s.run(["save", "--project", "demo", "--slug", "x", "--file", f]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required section\(s\): ## Next step/);
});

test("save builds the chain, moves LATEST, logs decisions", () => {
  const s = sandbox();
  const r1 = s.run(["save", "--project", "demo", "--slug", "first", "--file", draft(s.base, GOOD)]);
  assert.equal(r1.status, 0, r1.stderr);
  const first = r1.stdout.trim();
  assert.match(fs.readFileSync(first, "utf8"), /^Supersedes: none \(first handoff\)$/m);

  const second = GOOD.replace("- Remove background locally. Why: free.", "- None");
  const r2 = s.run(["save", "--project", "demo", "--slug", "second", "--file", draft(s.base, second)]);
  assert.equal(r2.status, 0, r2.stderr);
  const p2 = r2.stdout.trim();
  assert.match(fs.readFileSync(p2, "utf8"), new RegExp(`^Supersedes: ${path.basename(first)}$`, "m"));
  assert.equal(fs.readFileSync(path.join(s.root, "demo", "LATEST"), "utf8").trim(), path.basename(p2));
  assert.equal(s.run(["latest", "--project", "demo"]).stdout.trim(), p2);

  const ledger = fs.readFileSync(path.join(s.root, "demo", "DECISIONS.md"), "utf8");
  const lines = ledger.split("\n").filter((l) => l.startsWith("- "));
  // 2 from first handoff, 1 from second ("None" is skipped)
  assert.equal(lines.length, 3);
  assert.match(lines[2], /Use Creatify Aurora.*\[.*second\.md\]/);
});

test("refuses to treat the home folder as a project", () => {
  const s = sandbox();
  const r = s.run(["latest"], s.home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /home folder, which is not a project/);
});

test("derives project from git toplevel, not the subfolder", () => {
  const s = sandbox();
  const repo = path.join(s.base, "My_Repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  assert.equal(s.run(["project"], path.join(repo, "src")).stdout.trim(), "my-repo");
});

test("works when invoked through a symlinked skill dir", () => {
  const s = sandbox();
  const link = path.join(s.base, "linked-skill");
  fs.symlinkSync(path.dirname(SCRIPT), link);
  const r = s.run(["project", "--project", "via-link"], s.base, path.join(link, "handoff.mjs"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "via-link");
});

test("refuses a hand-written Supersedes line", () => {
  const s = sandbox();
  const f = draft(s.base, GOOD.replace("Date:", "Supersedes: fake.md\nDate:"));
  const r = s.run(["save", "--project", "demo", "--slug", "x", "--file", f]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /script adds it/);
});

// ---- keyed save (automated runs) --------------------------------------------
const KEYED = (key, decision = "Keep the pinned base. Why: rework inherits it.") =>
  `# Handoff: automated run\nAttempt-Key: ${key}\n\n## Where we are\nDone.\n\n## What we decided\n- ${decision}\n\n## Next step\nReview.\n`;
const ledgerLines = (root, p, name) => fs.readFileSync(path.join(root, p, "DECISIONS.md"), "utf8").split("\n").filter((l) => l.includes(`](${name})`)).length;
const mdFiles = (root, p) => fs.readdirSync(path.join(root, p)).filter((n) => n.endsWith(".md") && n !== "DECISIONS.md");

test("keyed save writes once; a rerun repairs instead of duplicating", () => {
  const s = sandbox();
  const d = draft(s.base, KEYED("a-0001"));
  const first = s.run(["save", "--project", "demo", "--slug", "run-a-0001", "--file", d, "--key", "a-0001"]);
  assert.equal(first.status, 0, first.stderr);
  const again = s.run(["save", "--project", "demo", "--slug", "run-a-0001", "--file", d, "--key", "a-0001"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /already saved/);
  assert.equal(mdFiles(s.root, "demo").length, 1);
  assert.equal(ledgerLines(s.root, "demo", path.basename(first.stdout.trim())), 1);
});

test("keyed save refuses a draft whose Attempt-Key line does not match", () => {
  const s = sandbox();
  const r = s.run(["save", "--project", "demo", "--slug", "run-x", "--file", draft(s.base, KEYED("a-other")), "--key", "a-0001"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires the draft to carry the line "Attempt-Key: a-0001"/);
});

// In-process so a crash can be injected between steps; ROOT is read once at import.
const crashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-crash-"));
process.env.HANDOFF_ROOT = crashRoot;
const { save } = await import(`./handoff.mjs?crash=${Date.now()}`);
const crash = () => { throw new Error("crash"); };

for (const step of ["afterFile", "afterLatest"]) {
  test(`keyed save converges after a crash at ${step}`, () => {
    const p = `crash-${step.toLowerCase()}`;
    const d = draft(crashRoot, KEYED("a-0002"));
    assert.throws(() => save({ project: p, slug: "run-a-0002", file: d, key: "a-0002", hooks: { [step]: crash } }), /crash/);
    const r = save({ project: p, slug: "run-a-0002", file: d, key: "a-0002" });
    assert.equal(r.repaired, true);
    const name = path.basename(r.path);
    assert.deepEqual(mdFiles(crashRoot, p), [name]);
    assert.equal(fs.readFileSync(path.join(crashRoot, p, "LATEST"), "utf8").trim(), name);
    assert.equal(ledgerLines(crashRoot, p, name), 1);
    save({ project: p, slug: "run-a-0002", file: d, key: "a-0002" });
    assert.equal(ledgerLines(crashRoot, p, name), 1);
  });
}

test("a keyed rerun never moves LATEST back past a newer handoff", () => {
  const p = "no-rewind";
  const k = save({ project: p, slug: "run-a-0003", file: draft(crashRoot, KEYED("a-0003")), key: "a-0003", now: new Date("2026-09-30T10:00:00") });
  const newer = save({ project: p, slug: "later-work", file: draft(crashRoot, GOOD), now: new Date("2026-09-30T11:00:00") });
  save({ project: p, slug: "run-a-0003", file: draft(crashRoot, KEYED("a-0003")), key: "a-0003" });
  assert.equal(fs.readFileSync(path.join(crashRoot, p, "LATEST"), "utf8").trim(), path.basename(newer.path));
  assert.equal(ledgerLines(crashRoot, p, path.basename(k.path)), 1);
});
