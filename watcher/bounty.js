#!/usr/bin/env node
/**
 * bounty — unified CLI for GrantFox + Drips Wave bounty hunting.
 *
 * Usage:
 *   node bounty.js grantfox [--dry] [--auto]   find + draft + optionally post GrantFox applications
 *   node bounty.js drips [--dry]               find + draft Drips shortlist (apply via their UI)
 *   node bounty.js all [--dry] [--auto]        run both sources in sequence
 *   node bounty.js applied list|add|remove|import-posted|import-assigned|prune  manage exclusions
 *   node bounty.js drips-waves                 list available Drips wave IDs
 *
 * Flags:
 *   --dry       preview candidates without writing/posting anything
 *   --auto      (GrantFox only) post applications via gh without review.ps1
 *   --loop      keep polling at config.poll_minutes interval
 *   --provider  override draft model provider (claude|gemini|openai)
 *   --model     override draft model name
 *
 * Environment:
 *   GITHUB_TOKEN        required (classic PAT, public_repo scope)
 *   GEMINI_API_KEY      optional, for Gemini drafting
 *   OPENAI_API_KEY      optional, for OpenAI drafting
 *   CLAUDE_BIN          optional, path to claude binary if not on PATH
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

// ── paths ──
const DIR = __dirname;
const APPLIED_PATH = path.join(DIR, "applied.json");
const GF_CONFIG_PATH = path.join(DIR, "config.json");
const GF_STATE_PATH = path.join(DIR, "state.json");
const GF_INBOX = path.join(DIR, "inbox");
const DRIPS_CONFIG_PATH = path.join(DIR, "drips-config.json");
const DRIPS_STATE_PATH = path.join(DIR, "drips-state.json");
const DRIPS_INBOX = path.join(DIR, "inbox-drips");
const PROMPT_PATH = path.join(DIR, "application-prompt.md");
const POSTED_DIR = path.join(DIR, "posted");

// ── cli args ──
const args = process.argv.slice(2);
const cmd = args[0] || "all";
const DRY = args.includes("--dry");
const AUTO = args.includes("--auto");
const LOOP = args.includes("--loop");
const flagVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

// ── shared state ──
function loadApplied() {
  if (!fs.existsSync(APPLIED_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(APPLIED_PATH, "utf8")).applied || {}; }
  catch { return {}; }
}
function saveApplied(applied) {
  fs.writeFileSync(APPLIED_PATH, JSON.stringify({ applied }, null, 2));
}
function normaliseRef(ref) {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (url) return `${url[1]}#${url[2]}`;
  const short = ref.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (short) return `${short[1]}#${short[2]}`;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── safety guards ──
const BAD_DRAFT = /(?:^|\n)\s*(note for|i wasn't able|i couldn't|i was unable|here's the draft|here is the draft|no problem,|i'll base the draft|tool (calls|access)\b)/im;
const SEP_LINE = /(?:^|\n)\s*-{3,}\s*(?:\n|$)/m;

function isDraftSafe(text) {
  if (!text || text.length < 20) return false;
  if (/DRAFT-FAILED|no ANTHROPIC_API_KEY set/i.test(text)) return false;
  if (BAD_DRAFT.test(text)) return false;
  if (SEP_LINE.test(text)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAFTING — multi-provider
// ═══════════════════════════════════════════════════════════════════════════

function buildPrompt(repo, issue) {
  return fs.readFileSync(PROMPT_PATH, "utf8")
    .replace("{{REPO}}", repo)
    .replace("{{TITLE}}", issue.title || "")
    .replace("{{URL}}", issue.url || issue.html_url || "")
    .replace("{{BODY}}", (issue.body || "").slice(0, 2500));
}

/** Draft via Claude Code CLI (uses your subscription, no API key). */
function draftClaude(prompt, model) {
  const bin = process.env.CLAUDE_BIN || "claude";
  const cliArgs = ["-p"];
  const m = model || "haiku";
  if (m && m !== "default") cliArgs.push("--model", m);
  try {
    return execFileSync(bin, cliArgs, {
      input: prompt, encoding: "utf8", timeout: 180000,
      maxBuffer: 10 * 1024 * 1024, windowsHide: true,
    }).trim() || null;
  } catch (e) {
    console.error(`  claude draft failed: ${(e.message || "").split("\n")[0]}`);
    return null;
  }
}

/** Draft via Gemini API. Needs GEMINI_API_KEY. */
async function draftGemini(prompt, model) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("  GEMINI_API_KEY not set"); return null; }
  const m = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 700 },
      }),
    });
    if (!res.ok) { console.error(`  Gemini API ${res.status}`); return null; }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error(`  gemini draft failed: ${(e.message || "").split("\n")[0]}`);
    return null;
  }
}

/** Draft via OpenAI-compatible API. Needs OPENAI_API_KEY. */
async function draftOpenAI(prompt, model) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error("  OPENAI_API_KEY not set"); return null; }
  const m = model || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) { console.error(`  OpenAI API ${res.status}`); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error(`  openai draft failed: ${(e.message || "").split("\n")[0]}`);
    return null;
  }
}

async function draft(repo, issue, providerOverride, modelOverride) {
  const prompt = buildPrompt(repo, issue);
  const provider = providerOverride || "claude";
  const model = modelOverride || null;

  let text;
  switch (provider) {
    case "gemini":  text = await draftGemini(prompt, model); break;
    case "openai":  text = await draftOpenAI(prompt, model); break;
    case "claude":
    default:        text = draftClaude(prompt, model); break;
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════════════════
// GRANTFOX — GitHub search + optional auto-post
// ═══════════════════════════════════════════════════════════════════════════

const GH_API = "https://api.github.com";
const ghHeaders = () => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bounty-watcher",
});

async function ghFetch(url, attempt = 0) {
  const res = await fetch(url, { headers: ghHeaders() });
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining != null && Number(remaining) <= 2) {
    console.log(`  (search quota low: ${remaining} left)`);
  }
  if (res.status === 403 || res.status === 429) {
    if (attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let wait = retryAfter ? retryAfter * 1000 : 0;
      if (!wait && reset) wait = Math.max(0, reset * 1000 - Date.now()) + 1000;
      if (!wait) wait = 30000 * (attempt + 1);
      console.log(`  rate limited, waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
      return ghFetch(url, attempt + 1);
    }
    throw new Error("GitHub rate limit exceeded after retries");
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res.json();
}

function postComment(issueUrl, body) {
  // issueUrl is like https://github.com/owner/repo/issues/123
  try {
    execSync(`gh issue comment "${issueUrl}" --body-file -`, {
      input: body, encoding: "utf8", timeout: 30000,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (e) {
    console.error(`  post failed: ${(e.message || "").split("\n")[0]}`);
    return false;
  }
}

async function runGrantFox() {
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set."); return;
  }

  const config = JSON.parse(fs.readFileSync(GF_CONFIG_PATH, "utf8"));
  const state = fs.existsSync(GF_STATE_PATH)
    ? JSON.parse(fs.readFileSync(GF_STATE_PATH, "utf8")) : { seen: {} };
  const applied = loadApplied();
  const provider = flagVal("--provider") || config.draft_provider || "claude";
  const model = flagVal("--model") || config.draft_model || null;

  if (!DRY) fs.mkdirSync(GF_INBOX, { recursive: true });

  const src = config.sources?.grantfox;
  if (!src || src.enabled === false) { console.log("[grantfox] disabled"); return; }

  // build query
  const parts = ["is:issue", "is:open", "no:assignee"];
  for (const l of src.labels || []) parts.push(`label:"${l}"`);
  const maxComments = src.max_comments ?? config.max_comments;
  if (maxComments != null) parts.push(`comments:<${maxComments}`);
  const days = src.recent_days ?? config.recent_days;
  if (days) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    parts.push(`created:>${since}`);
  }
  const me = config.github_username;
  if (me) parts.push(`-commenter:${me}`);
  if (src.extra_qualifiers) parts.push(src.extra_qualifiers);
  const q = parts.join(" ");

  console.log(`\n[grantfox] query: ${q}`);
  const limit = config.per_source_limit || 20;
  const perPage = Math.min(100, limit * 3);
  const url = `${GH_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${perPage}`;
  const data = await ghFetch(url);
  console.log(`[grantfox] ${data.total_count} match(es); pulled ${data.items.length}`);

  const spamRe = config.title_exclude_regex ? new RegExp(config.title_exclude_regex, "i") : null;
  const maxRepo = config.max_per_repo || 999;
  const perRepo = {};
  let kept = 0, posted = 0, written = 0, dropped = { spam: 0, applied: 0, repo: 0 };

  for (const issue of data.items) {
    if (kept >= limit) break;
    const repo = issue.repository_url.split("/repos/")[1];
    const key = `${repo}#${issue.number}`;
    if (state.seen[key] || applied[key]) { dropped.applied++; continue; }
    if (spamRe && spamRe.test(issue.title)) { state.seen[key] = new Date().toISOString(); dropped.spam++; continue; }
    perRepo[repo] = (perRepo[repo] || 0) + 1;
    if (perRepo[repo] > maxRepo) { dropped.repo++; continue; }

    console.log(`  NEW ${key} (${issue.comments} comments) — ${issue.title}`);
    kept++;
    if (DRY) continue;

    state.seen[key] = new Date().toISOString();
    const body = await draft(repo, { ...issue, url: issue.html_url }, provider, model);

    if (AUTO && body && isDraftSafe(body)) {
      // auto-post directly via gh
      if (postComment(issue.html_url, body)) {
        posted++;
        // record as applied so it never comes back
        applied[key] = { at: new Date().toISOString(), source: "grantfox-auto" };
        saveApplied(applied);
        // archive
        fs.mkdirSync(POSTED_DIR, { recursive: true });
        const slug = `grantfox--${repo.replace("/", "__")}--${issue.number}`;
        fs.writeFileSync(path.join(POSTED_DIR, `${slug}.md`),
          `# ${issue.title}\n- Repo: ${repo}\n- Issue: ${issue.html_url}\n- Posted: ${new Date().toISOString()}\n\n${body}\n`);
        console.log(`  POSTED`);
        await sleep(1200); // be polite
      } else {
        console.log(`  post failed, saved to inbox instead`);
        writeInbox(GF_INBOX, "grantfox", repo, issue, body);
        written++;
      }
    } else if (AUTO && body && !isDraftSafe(body)) {
      console.log(`  SKIPPED (unsafe draft: AI commentary detected)`);
      writeInbox(GF_INBOX, "grantfox", repo, issue, body);
      written++;
    } else {
      writeInbox(GF_INBOX, "grantfox", repo, issue, body);
      written++;
    }
  }

  fs.writeFileSync(GF_STATE_PATH, JSON.stringify(state, null, 2));
  const d = Object.entries(dropped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  if (d.length) console.log(`[grantfox] filtered: ${d.join(", ")}`);
  if (AUTO) console.log(`[grantfox] posted ${posted}, inbox ${written}`);
  else console.log(`[grantfox] ${written} written to inbox`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DRIPS — API-based, shortlist only (apply via their UI)
// ═══════════════════════════════════════════════════════════════════════════

const DRIPS_API = "https://wave-api.drips.network/api";

async function dripsApiFetch(pathname) {
  const res = await fetch(`${DRIPS_API}${pathname}`, {
    headers: { Accept: "application/json", "User-Agent": "bounty-watcher" },
  });
  if (!res.ok) throw new Error(`Drips API ${res.status} for ${pathname}`);
  return res.json();
}

async function runDrips() {
  if (!fs.existsSync(DRIPS_CONFIG_PATH)) {
    console.log("[drips] drips-config.json not found, skipping."); return;
  }
  const config = JSON.parse(fs.readFileSync(DRIPS_CONFIG_PATH, "utf8"));
  if (!config.waveProgramId || config.waveProgramId === "YOUR_WAVEPROGRAMID") {
    console.log("[drips] waveProgramId not set."); return;
  }

  const state = fs.existsSync(DRIPS_STATE_PATH)
    ? JSON.parse(fs.readFileSync(DRIPS_STATE_PATH, "utf8")) : { seen: {}, applied: {} };
  const applied = loadApplied();
  const provider = flagVal("--provider") || config.draft_provider || "claude";
  const model = flagVal("--model") || config.draft_model || null;
  const want = config.shortlist_size || 20;

  if (!DRY) fs.mkdirSync(DRIPS_INBOX, { recursive: true });

  console.log(`\n[drips] fetching wave ${config.waveProgramId.slice(0, 8)}...`);
  const perRepo = {};
  const kept = [];
  let dropped = { applicants: 0, points: 0, spam: 0, repo: 0, seen: 0 };
  let cursor = null;
  const spamRe = config.title_exclude_regex ? new RegExp(config.title_exclude_regex, "i") : null;

  for (let page = 1; page <= (config.max_pages || 8) && kept.length < want; page++) {
    let u = `/issues?limit=100&waveProgramId=${config.waveProgramId}&state=open&applicantAssigned=false&sortBy=${config.sort_by || "updatedAt"}`;
    if (cursor) u += `&cursor=${encodeURIComponent(cursor)}`;
    const data = await dripsApiFetch(u);
    const items = data.data || [];
    if (page === 1) console.log(`[drips] ${data.pagination?.total ?? "?"} open unassigned`);
    if (!items.length) break;

    for (const it of items) {
      if (kept.length >= want) break;
      const repo = it.repo?.gitHubRepoFullName || "unknown/unknown";
      const key = `${repo}#${it.gitHubIssueNumber}`;
      if (state.seen[key] || state.applied?.[key] || applied[key]) { dropped.seen++; continue; }
      if (config.max_pending_applications != null && it.pendingApplicationsCount > config.max_pending_applications) { dropped.applicants++; continue; }
      if (config.min_points != null && (it.points ?? 0) < config.min_points) { dropped.points++; continue; }
      if (spamRe && spamRe.test(it.title)) { dropped.spam++; continue; }
      perRepo[repo] = (perRepo[repo] || 0) + 1;
      if (perRepo[repo] > (config.max_per_repo || 99)) { dropped.repo++; continue; }
      kept.push(it);
    }
    cursor = data.pagination?.nextCursor;
    if (!data.pagination?.hasNextPage || !cursor) break;
    await sleep(400);
  }

  console.log(`[drips] ${kept.length} shortlisted`);
  const d = Object.entries(dropped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  if (d.length) console.log(`[drips] filtered: ${d.join(", ")}`);

  for (const it of kept) {
    const repo = it.repo.gitHubRepoFullName;
    const key = `${repo}#${it.gitHubIssueNumber}`;
    const gh = `${it.repo.gitHubRepoUrl}/issues/${it.gitHubIssueNumber}`;
    const dripsUrl = `https://www.drips.network/wave/${config.wave_slug || "stellar"}/issues/${it.id}`;

    console.log(`  ${key}  ${it.points}pts  ${it.pendingApplicationsCount} app(s)  ${it.title.slice(0, 70)}`);
    if (DRY) continue;

    state.seen[key] = new Date().toISOString();
    const body = await draft(repo, { title: it.title, body: it.body, url: gh }, provider, model);
    const slug = `${repo.replace("/", "__")}--${it.gitHubIssueNumber}`;
    fs.writeFileSync(path.join(DRIPS_INBOX, `${slug}.md`), [
      `# ${it.title}`, ``,
      `- Repo: ${repo}`, `- GitHub: ${gh}`,
      `- APPLY HERE: ${dripsUrl}`,
      `- Points: ${it.points} (x${it.pointsMultiplier})`,
      `- Complexity: ${it.complexity}`,
      `- Pending applications: ${it.pendingApplicationsCount}`,
      `- Created: ${it.gitHubCreatedAt}`, ``,
      `> Apply through the Drips link above. A GitHub comment does NOT count.`, ``,
      `## Issue body`, ``, (it.body || "(empty)").slice(0, 6000), ``,
      `## Drafted application (paste into the Drips form)`, ``,
      body || "DRAFT-FAILED: write this one yourself.", ``,
    ].join("\n"));
  }

  if (!DRY) fs.writeFileSync(DRIPS_STATE_PATH, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLIED — manage the shared exclusion list
// ═══════════════════════════════════════════════════════════════════════════

function runApplied() {
  const sub = args[1] || "list";
  const refs = args.slice(2).filter((a) => !a.startsWith("--"));
  const applied = loadApplied();

  switch (sub) {
    case "list": {
      const keys = Object.keys(applied).sort();
      if (!keys.length) { console.log("Nothing recorded."); return; }
      console.log(`${keys.length} applied/excluded:\n`);
      for (const k of keys) {
        const v = applied[k];
        console.log(`  ${k.padEnd(52)} ${(v.at || "").slice(0, 10)}  ${v.source || ""}${v.note ? "  (" + v.note + ")" : ""}`);
      }
      break;
    }
    case "add": {
      let note = null;
      const items = [...refs];
      const ni = items.indexOf("--note");
      if (ni !== -1) { note = items[ni + 1]; items.splice(ni, 2); }
      let n = 0;
      for (const r of items) {
        const key = normaliseRef(r);
        if (!key || applied[key]) continue;
        applied[key] = { at: new Date().toISOString(), source: "manual", ...(note ? { note } : {}) };
        n++;
      }
      saveApplied(applied); console.log(`Added ${n}. Total: ${Object.keys(applied).length}`);
      break;
    }
    case "remove": {
      let n = 0;
      for (const r of refs) { const k = normaliseRef(r); if (k && applied[k]) { delete applied[k]; n++; } }
      saveApplied(applied); console.log(`Removed ${n}. Total: ${Object.keys(applied).length}`);
      break;
    }
    case "import-posted": {
      if (!fs.existsSync(POSTED_DIR)) { console.error("No posted/ folder."); return; }
      let n = 0;
      for (const f of fs.readdirSync(POSTED_DIR).filter((f) => f.endsWith(".md"))) {
        const t = fs.readFileSync(path.join(POSTED_DIR, f), "utf8");
        const m = t.match(/- Issue:\s*(\S+)/);
        if (!m) continue;
        const key = normaliseRef(m[1]);
        if (!key || applied[key]) continue;
        applied[key] = { at: new Date().toISOString(), source: "grantfox-posted" };
        n++;
      }
      saveApplied(applied); console.log(`Added ${n}. Total: ${Object.keys(applied).length}`);
      break;
    }
    case "import-assigned": {
      try {
        const out = execFileSync("gh", [
          "issue", "list", "--assignee", "@me", "--state", "open",
          "--limit", "100", "--json", "number,title,url",
        ], { encoding: "utf8" });
        let n = 0;
        for (const i of JSON.parse(out)) {
          const key = normaliseRef(i.url);
          if (!key || applied[key]) continue;
          applied[key] = { at: new Date().toISOString(), source: "assigned" };
          n++;
        }
        saveApplied(applied); console.log(`Added ${n}. Total: ${Object.keys(applied).length}`);
      } catch { console.error("gh failed. Is it installed and authenticated?"); }
      break;
    }
    case "prune": {
      const days = parseInt(refs[0] || "90", 10);
      const cutoff = Date.now() - days * 864e5;
      let n = 0;
      for (const [k, v] of Object.entries(applied)) {
        if (new Date(v.at).getTime() < cutoff) { delete applied[k]; n++; }
      }
      saveApplied(applied); console.log(`Pruned ${n}. Total: ${Object.keys(applied).length}`);
      break;
    }
    default:
      console.log(`
Usage: node bounty.js applied <command>

  list                    show everything
  add <ref>... [--note x] record applications
  remove <ref>...         un-record
  import-posted           import from posted/
  import-assigned         import GitHub assignments
  prune <days>            drop old entries
`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function writeInbox(dir, source, repo, issue, body) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = `${source}--${repo.replace("/", "__")}--${issue.number || issue.gitHubIssueNumber}`;
  const url = issue.html_url || issue.url || "";
  fs.writeFileSync(path.join(dir, `${slug}.md`), [
    `# ${issue.title}`, ``,
    `- Source: ${source}`, `- Repo: ${repo}`, `- Issue: ${url}`,
    `- Comments: ${issue.comments ?? "?"}`,
    `- Created: ${issue.created_at || issue.gitHubCreatedAt || "?"}`, ``,
    `## Issue body`, ``, (issue.body || "(empty)").slice(0, 6000), ``,
    `## Drafted application (REVIEW AND EDIT BEFORE POSTING)`, ``,
    body || "DRAFT-FAILED: write the application yourself.", ``,
  ].join("\n"));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  switch (cmd) {
    case "grantfox": case "gf": await runGrantFox(); break;
    case "drips": await runDrips(); break;
    case "all": await runGrantFox(); await runDrips(); break;
    case "applied": runApplied(); break;
    case "drips-waves": {
      const data = await dripsApiFetch("/wave-programs?limit=100");
      console.log("\nAvailable wave programs:\n");
      for (const w of data.data || data) console.log(`  ${w.id}  ${w.name || w.slug || "(unnamed)"}`);
      break;
    }
    default:
      console.log(`
bounty — unified GrantFox + Drips Wave bounty automation

  node bounty.js grantfox [--dry] [--auto]     find and draft (--auto posts them)
  node bounty.js drips [--dry]                  shortlist for manual Drips apply
  node bounty.js all [--dry] [--auto]           both sources
  node bounty.js applied list|add|remove|...    manage exclusion list
  node bounty.js drips-waves                    list wave IDs

Flags:
  --dry        preview only
  --auto       auto-post GrantFox applications (not Drips)
  --loop       repeat at poll_minutes interval
  --provider   claude | gemini | openai
  --model      specific model name

Providers:
  claude   uses your Claude subscription via the CLI (default, no API key)
  gemini   needs GEMINI_API_KEY env var
  openai   needs OPENAI_API_KEY env var
`);
  }
}

async function loop() {
  const config = fs.existsSync(GF_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(GF_CONFIG_PATH, "utf8")) : {};
  do {
    try { await main(); }
    catch (e) { console.error("Error:", e.message); }
    if (LOOP) {
      const mins = config.poll_minutes || 20;
      console.log(`\nSleeping ${mins} min...`);
      await sleep(mins * 60000);
    }
  } while (LOOP);
}

loop();
