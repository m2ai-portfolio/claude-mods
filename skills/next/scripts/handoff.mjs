#!/usr/bin/env node
// Deterministic half of the /next and /prime skills. The model writes the prose;
// this script owns filenames, the Supersedes chain, LATEST, and DECISIONS.md so
// no harness (Claude, Codex, local model) can get the bookkeeping wrong.
//
//   handoff.mjs project [--project P]          print resolved project slug
//   handoff.mjs latest  [--project P]          print absolute path of latest handoff
//   handoff.mjs history [--project P]          print absolute path of DECISIONS.md
//   handoff.mjs list                           every project and its latest handoff
//   handoff.mjs save --slug S --file F [--project P] [--key K]
//                                              validate draft F, store it, move LATEST
//                                              --key: idempotent keyed save (automated runs);
//                                              a rerun repairs instead of writing twice
//
// Root is ~/handoffs, overridable with HANDOFF_ROOT (tests).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.HANDOFF_ROOT || path.join(os.homedir(), "handoffs");
const REQUIRED = ["## Where we are", "## What we decided", "## Next step"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function die(msg) {
  process.stderr.write(`handoff: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) die(`missing value for ${a}`);
      out[a.slice(2)] = v;
      i++;
    } else out._.push(a);
  }
  return out;
}

export function resolveProject(explicit, cwd = process.cwd()) {
  if (explicit) {
    if (!SLUG_RE.test(explicit)) die(`project "${explicit}" must be kebab-case`);
    return explicit;
  }
  let dir = cwd;
  try {
    dir = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git repo: fall back to cwd
  }
  const home = process.env.HANDOFF_HOME || os.homedir();
  if (path.resolve(dir) === path.resolve(home) || dir === "/") {
    die(
      "working directory is the home folder, which is not a project. " +
        "Pass --project <kebab-name> (run `list` to see existing projects).",
    );
  }
  const slug = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(slug)) die(`could not derive a project slug from ${dir}; pass --project`);
  return slug;
}

function projectDir(p) {
  return path.join(ROOT, p);
}

export function latestPath(p) {
  const pointer = path.join(projectDir(p), "LATEST");
  if (!fs.existsSync(pointer)) return null;
  const name = fs.readFileSync(pointer, "utf8").trim();
  const full = path.join(projectDir(p), name);
  if (!name || !fs.existsSync(full)) die(`LATEST in ${p} points at missing file "${name}"`);
  return full;
}

function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
}

export function extractDecisions(md) {
  const m = md.match(/^## What we decided\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/))
    .filter(Boolean)
    .map((x) => x[1])
    .filter((t) => !/^(none|n\/a|no decisions?)\.?$/i.test(t));
}

const attemptKeyOf = (md) => md.match(/^Attempt-Key:\s*(\S+)\s*$/m)?.[1] ?? null;

// Keyed save (automated runs, e.g. a sandboxed worker): the file carrying `Attempt-Key: K` is written once. A rerun
// after a crash between steps skips the write, moves LATEST only if it points at an
// older handoff, and appends ledger lines only if DECISIONS.md does not cite the file.
// Order stays file, LATEST, ledger; `hooks` lets tests crash between steps.
export function save({ project, slug, file, key, now = new Date(), hooks = {} }) {
  if (!slug || !SLUG_RE.test(slug)) die("--slug must be kebab-case, e.g. avatar-cutout");
  if (!file || !fs.existsSync(file)) die(`draft file not found: ${file}`);
  let md = fs.readFileSync(file, "utf8");
  const missing = REQUIRED.filter((h) => !new RegExp(`^${h}\\s*$`, "m").test(md));
  if (missing.length) die(`draft is missing required section(s): ${missing.join(", ")}`);
  if (/^Supersedes:/m.test(md)) die("do not write a Supersedes: line; the script adds it");
  if (key !== undefined && (!/^\S+$/.test(key) || attemptKeyOf(md) !== key)) die(`--key ${key} requires the draft to carry the line "Attempt-Key: ${key}"`);

  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const existing = key === undefined ? null : fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "DECISIONS.md")
    .find((n) => attemptKeyOf(fs.readFileSync(path.join(dir, n), "utf8")) === key);
  const prev = latestPath(project);
  let name, full;
  if (existing) {
    name = existing; full = path.join(dir, name); md = fs.readFileSync(full, "utf8");
  } else {
    name = `${stamp(now)}-${slug}.md`;
    full = path.join(dir, name);
    if (fs.existsSync(full)) die(`${name} already exists; handoffs are immutable, use a new slug`);
    // Insert the chain link after the H1 title line.
    const link = `Supersedes: ${prev ? path.basename(prev) : "none (first handoff)"}`;
    md = /^# .*$/m.test(md) ? md.replace(/^(# .*)$/m, `$1\n${link}`) : `${link}\n\n${md}`;
    fs.writeFileSync(full, md, { flag: "wx" });
  }
  hooks.afterFile?.();

  // Timestamped names sort by age, so "older" is a plain string compare.
  if (!existing || !prev || path.basename(prev) < name) {
    const tmp = path.join(dir, `.LATEST.${process.pid}`);
    fs.writeFileSync(tmp, `${name}\n`);
    fs.renameSync(tmp, path.join(dir, "LATEST"));
  }
  hooks.afterLatest?.();

  const decisions = extractDecisions(md);
  const ledger = path.join(dir, "DECISIONS.md");
  if (!fs.existsSync(ledger)) {
    fs.writeFileSync(ledger, `# Decisions: ${project}\n\nAppend-only. One line per decision, newest last.\n\n`);
  }
  const cited = existing && fs.readFileSync(ledger, "utf8").includes(`](${name})`);
  if (decisions.length && !cited) {
    const day = name.slice(0, 10);
    fs.appendFileSync(ledger, decisions.map((d) => `- ${day} · ${d} · [${name}](${name})\n`).join(""));
  }
  return { path: full, decisions: cited ? 0 : decisions.length, supersedes: prev ? path.basename(prev) : null, repaired: Boolean(existing) };
}

function listProjects() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => {
      const pointer = path.join(ROOT, e.name, "LATEST");
      return { project: e.name, latest: fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : "(none)" };
    });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case "project":
      console.log(resolveProject(args.project));
      break;
    case "latest": {
      const p = resolveProject(args.project);
      const l = latestPath(p);
      if (!l) die(`no handoffs yet for project "${p}" (looked in ${projectDir(p)})`);
      console.log(l);
      break;
    }
    case "history": {
      const p = resolveProject(args.project);
      const f = path.join(projectDir(p), "DECISIONS.md");
      if (!fs.existsSync(f)) die(`no DECISIONS.md yet for project "${p}"`);
      console.log(f);
      break;
    }
    case "list":
      for (const r of listProjects()) console.log(`${r.project}\t${r.latest}`);
      break;
    case "save": {
      const r = save({ project: resolveProject(args.project), slug: args.slug, file: args.file, key: args.key });
      console.log(r.path);
      console.error(`${r.repaired ? "already saved (repaired LATEST/ledger if needed)" : `supersedes: ${r.supersedes ?? "none"}`}; decisions logged: ${r.decisions}`);
      break;
    }
    default:
      die("usage: handoff.mjs <project|latest|history|list|save> [--project P] [--slug S --file F [--key K]]");
  }
}

// realpath both sides: other harnesses may reach this file through a symlinked skill dir.
const invoked = process.argv[1] && fs.realpathSync(process.argv[1]);
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) main();
