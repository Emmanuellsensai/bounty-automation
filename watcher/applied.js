#!/usr/bin/env node
/**
 * applied.js - one exclusion list shared by watch.js (GrantFox) and drips.js.
 *
 * Both watchers read applied.json and skip anything listed in it, so an issue
 * you have applied to never resurfaces on either source.
 *
 * GrantFox already gets server-side dedup via `-commenter:<you>` in the search
 * query. This list covers everything that cannot: Drips applications (submitted
 * through their UI, no GitHub comment), applications you made manually, issues
 * you deliberately never want to see again, and assignments already in progress.
 *
 * Usage:
 *   node applied.js list
 *   node applied.js add "owner/repo#123" "owner/repo#456"
 *   node applied.js add --note "too big" "owner/repo#789"
 *   node applied.js remove "owner/repo#123"
 *   node applied.js import-posted        pull everything from watcher posted/
 *   node applied.js import-assigned      pull your open GitHub assignments (needs gh)
 *   node applied.js import-drips         migrate old drips-state.json entries
 *   node applied.js prune 90             drop entries older than N days
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FILE = path.join(__dirname, "applied.json");

function load() {
  if (!fs.existsSync(FILE)) return { applied: {} };
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}
function save(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}
function normalise(ref) {
  // accept owner/repo#123 or a full GitHub issue URL
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (url) return `${url[1]}#${url[2]}`;
  const short = ref.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (short) return `${short[1]}#${short[2]}`;
  return null;
}

const db = load();
const [, , cmd, ...rest] = process.argv;

function addRefs(refs, source, note) {
  let n = 0, bad = [];
  for (const r of refs) {
    const key = normalise(r);
    if (!key) { bad.push(r); continue; }
    if (db.applied[key]) continue;
    db.applied[key] = {
      at: new Date().toISOString(),
      source: source || "manual",
      ...(note ? { note } : {}),
    };
    n++;
  }
  save(db);
  console.log(`Added ${n} entr${n === 1 ? "y" : "ies"}. Total: ${Object.keys(db.applied).length}`);
  if (bad.length) console.log(`Ignored ${bad.length} unrecognised ref(s): ${bad.join(", ")}`);
}

switch (cmd) {
  case "list": {
    const keys = Object.keys(db.applied).sort();
    if (!keys.length) { console.log("Nothing recorded yet."); break; }
    console.log(`${keys.length} applied/excluded:\n`);
    for (const k of keys) {
      const v = db.applied[k];
      const when = (v.at || "").slice(0, 10);
      console.log(`  ${k.padEnd(52)} ${when}  ${v.source}${v.note ? "  (" + v.note + ")" : ""}`);
    }
    break;
  }

  case "add": {
    let note = null;
    const args = [...rest];
    const ni = args.indexOf("--note");
    if (ni !== -1) { note = args[ni + 1]; args.splice(ni, 2); }
    if (!args.length) { console.error('Usage: node applied.js add "owner/repo#123"'); process.exit(1); }
    addRefs(args, "manual", note);
    break;
  }

  case "remove": {
    let n = 0;
    for (const r of rest) {
      const key = normalise(r);
      if (key && db.applied[key]) { delete db.applied[key]; n++; }
    }
    save(db);
    console.log(`Removed ${n}. Total: ${Object.keys(db.applied).length}`);
    break;
  }

  case "import-posted": {
    const dir = path.join(__dirname, "posted");
    if (!fs.existsSync(dir)) { console.error(`No posted/ folder at ${dir}`); process.exit(1); }
    const refs = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
      const t = fs.readFileSync(path.join(dir, f), "utf8");
      const m = t.match(/- Issue:\s*(\S+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    addRefs(refs, "grantfox-posted");
    break;
  }

  case "import-assigned": {
    try {
      const out = execFileSync("gh", [
        "issue", "list", "--assignee", "@me", "--state", "open",
        "--limit", "100", "--json", "number,repository",
      ], { encoding: "utf8" });
      const refs = JSON.parse(out).map(
        (i) => `${i.repository.nameWithOwner}#${i.number}`
      );
      addRefs(refs, "assigned");
    } catch (e) {
      console.error("gh failed. Is it installed and authenticated?");
      process.exit(1);
    }
    break;
  }

  case "import-drips": {
    const p = path.join(__dirname, "drips-state.json");
    if (!fs.existsSync(p)) { console.error("No drips-state.json found."); process.exit(1); }
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    addRefs(Object.keys(s.applied || {}), "drips");
    break;
  }

  case "prune": {
    const days = parseInt(rest[0] || "90", 10);
    const cutoff = Date.now() - days * 864e5;
    let n = 0;
    for (const [k, v] of Object.entries(db.applied)) {
      if (new Date(v.at).getTime() < cutoff) { delete db.applied[k]; n++; }
    }
    save(db);
    console.log(`Pruned ${n} older than ${days} days. Total: ${Object.keys(db.applied).length}`);
    break;
  }

  default:
    console.log(`
applied.js - shared exclusion list for both watchers

  list                       show everything recorded
  add <ref>... [--note "x"]  record applications (owner/repo#123 or issue URL)
  remove <ref>...            un-record
  import-posted              import from the GrantFox posted/ folder
  import-assigned            import your open GitHub assignments (needs gh)
  import-drips               migrate old drips-state.json entries
  prune <days>               drop entries older than N days
`);
}
