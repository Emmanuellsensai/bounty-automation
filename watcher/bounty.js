#!/usr/bin/env node
/**
 * bounty - GrantFox + Drips Wave bounty automation
 *   node bounty.js grantfox [--dry]   high-complexity issues, draft, open browser
 *   node bounty.js drips [--dry]      200+ pt issues, draft, open browser
 *   node bounty.js all [--dry]        both sources
 *   node bounty.js applied ...        manage exclusion list
 *   node bounty.js drips-waves        list wave IDs
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const os = require("os");
const DIR = __dirname;
const APPLIED_PATH = path.join(DIR, "applied.json");
const GF_CONFIG = path.join(DIR, "config.json");
const GF_STATE = path.join(DIR, "state.json");
const GF_INBOX = path.join(DIR, "inbox");
const DRIPS_CONFIG = path.join(DIR, "drips-config.json");
const DRIPS_STATE = path.join(DIR, "drips-state.json");
const DRIPS_INBOX = path.join(DIR, "inbox-drips");
const PROMPT_PATH = path.join(DIR, "application-prompt.md");
const args = process.argv.slice(2);
const cmd = args[0] || "all";
const DRY = args.includes("--dry");
function loadApplied() {
  if (!fs.existsSync(APPLIED_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(APPLIED_PATH, "utf8")).applied || {}; }
  catch { return {}; }
}
function saveApplied(a) { fs.writeFileSync(APPLIED_PATH, JSON.stringify({ applied: a }, null, 2)); }
function normaliseRef(r) {
  let m = r.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i);
  if (m) return m[1] + "#" + m[2];
  m = r.match(/^([^\s/]+\/[^#\s]+)#(\d+)$/);
  if (m) return m[1] + "#" + m[2];
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BAD_DRAFT = /(?:^|\n)\s*(note for|i wasn't able|i couldn't|i was unable|here's the draft|here is the draft|no problem,|i'll base the draft|tool (calls|access)\b)/im;
const SEP_LINE = /(?:^|\n)\s*-{3,}\s*(?:\n|$)/m;
function isDraftSafe(t) {
  if (!t || t.length < 20) return false;
  if (/DRAFT-FAILED|GEMINI_API_KEY not set/i.test(t)) return false;
  if (BAD_DRAFT.test(t) || SEP_LINE.test(t)) return false;
  return true;
}
function openBrowser(url) {
  try {
    const p = os.platform();
    if (p === "win32") execSync('start "" "' + url + '"', { stdio: "ignore", windowsHide: true });
    else if (p === "darwin") execSync('open "' + url + '"', { stdio: "ignore" });
    else execSync('xdg-open "' + url + '"', { stdio: "ignore" });
    return true;
  } catch { return false; }
}
function buildGFUrl(owner, repo, num) {
  return "https://contribute.grantfox.xyz/org/" + owner + "/repo/" + repo + "/issue/" + num;
}
function buildPrompt(repo, issue) {
  return fs.readFileSync(PROMPT_PATH, "utf8")
    .replace("{{REPO}}", repo)
    .replace("{{TITLE}}", issue.title || "")
    .replace("{{URL}}", issue.url || issue.html_url || "")
    .replace("{{BODY}}", (issue.body || "").slice(0, 2500));
}
async function draft(repo, issue) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("  GEMINI_API_KEY not set"); return null; }
  const prompt = buildPrompt(repo, issue);
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + key;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 700 } }),
    });
    if (!res.ok) { console.error("  Gemini API " + res.status); return null; }
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim() || null;
  } catch (e) { console.error("  gemini failed: " + (e.message || "").split("\n")[0]); return null; }
}
const GH_API = "https://api.github.com";
const ghH = () => ({
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + process.env.GITHUB_TOKEN,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bounty-watcher",
});
async function ghFetch(url, att) {
  att = att || 0;
  const res = await fetch(url, { headers: ghH() });
  const rem = res.headers.get("x-ratelimit-remaining");
  if (rem != null && Number(rem) <= 2) console.log("  quota low: " + rem);
  if (res.status === 403 || res.status === 429) {
    if (att < 3) {
      const ra = Number(res.headers.get("retry-after"));
      const rst = Number(res.headers.get("x-ratelimit-reset"));
      let w = ra ? ra * 1000 : 0;
      if (!w && rst) w = Math.max(0, rst * 1000 - Date.now()) + 1000;
      if (!w) w = 30000 * (att + 1);
      console.log("  rate limited, waiting " + Math.round(w / 1000) + "s...");
      await sleep(w);
      return ghFetch(url, att + 1);
    }
    throw new Error("GitHub rate limit exceeded");
  }
  if (!res.ok) throw new Error("GitHub " + res.status + ": " + url);
  return res.json();
}
async function runGrantFox() {
  if (!process.env.GITHUB_TOKEN) { console.error("GITHUB_TOKEN not set."); return; }
  const config = JSON.parse(fs.readFileSync(GF_CONFIG, "utf8"));
  const state = fs.existsSync(GF_STATE) ? JSON.parse(fs.readFileSync(GF_STATE, "utf8")) : { seen: {} };
  const applied = loadApplied();
  const src = config.sources && config.sources.grantfox;
  if (!src || src.enabled === false) { console.log("[grantfox] disabled"); return; }
  const cplx = src.complexity_labels || ["Complexity: High", "Complexity: Hardcore", "Difficulty: Advanced", "High"];
  const maxC = src.max_comments != null ? src.max_comments : (config.max_comments != null ? config.max_comments : 5);
  const limit = config.per_source_limit || 4;
  const maxR = config.max_per_repo || 4;
  const parts = ["is:issue", "is:open", "no:assignee"];
  (src.labels || []).forEach(l => parts.push('label:"' + l + '"'));
  if (maxC != null) parts.push("comments:<" + maxC);
  const days = src.recent_days != null ? src.recent_days : config.recent_days;
  if (days) { parts.push("created:>" + new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)); }
  const me = config.github_username;
  if (me) parts.push("-commenter:" + me);
  if (src.exclude_labels) src.exclude_labels.forEach(l => parts.push('-label:"' + l + '"'));
  if (src.extra_qualifiers) parts.push(src.extra_qualifiers);
  const q = parts.join(" ");
  console.log("\n[grantfox] Searching for high-complexity issues...");
  console.log("[grantfox] query: " + q);
  const perPage = Math.min(100, limit * 10);
  const data = await ghFetch(GH_API + "/search/issues?q=" + encodeURIComponent(q) + "&sort=created&order=desc&per_page=" + perPage);
  console.log("[grantfox] " + data.total_count + " total; pulled " + data.items.length);
  const spamRe = config.title_exclude_regex ? new RegExp(config.title_exclude_regex, "i") : null;
  const dropped = { spam: 0, applied: 0, repo: 0, complexity: 0, comments: 0 };
  // Group eligible issues by repo for round-robin selection
  const byRepo = {};
  for (const issue of data.items) {
    const repo = issue.repository_url.split("/repos/")[1];
    const key = repo + "#" + issue.number;
    if (state.seen[key] || applied[key]) { dropped.applied++; continue; }
    if (spamRe && spamRe.test(issue.title)) { state.seen[key] = new Date().toISOString(); dropped.spam++; continue; }
    const issueLabels = issue.labels.map(l => typeof l === "string" ? l : l.name);
    if (!issueLabels.some(l => cplx.some(cl => cl.toLowerCase() === l.toLowerCase()))) { dropped.complexity++; continue; }
    if (issue.comments >= maxC) { dropped.comments++; continue; }
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push({ issue, repo, key });
  }
  // Pick up to maxR issues per repo, prioritizing repos with more qualifying issues
  const kept = [];
  const reposByCount = Object.keys(byRepo).sort((a, b) => byRepo[b].length - byRepo[a].length);
  for (const repo of reposByCount) {
    const issues = byRepo[repo];
    const take = Math.min(maxR, issues.length);
    for (let i = 0; i < take && kept.length < limit; i++) {
      kept.push(issues[i]);
    }
  }
  const d = Object.entries(dropped).filter(e => e[1]).map(e => e[1] + " " + e[0]);
  if (d.length) console.log("[grantfox] filtered: " + d.join(", "));
  console.log("[grantfox] " + kept.length + " high-complexity issue(s) selected\n");
  if (!kept.length) return;
  const urls = [];
  for (let i = 0; i < kept.length; i++) {
    const { issue, repo, key } = kept[i];
    const [owner, rp] = repo.split("/");
    const gfUrl = buildGFUrl(owner, rp, issue.number);
    const labels = issue.labels.map(l => l.name || l).join(", ") || "none";
    console.log("  " + (i + 1) + ". " + key + ' -- "' + issue.title + '"');
    console.log("     Comments: " + issue.comments + " | Labels: " + labels);
    console.log("     GrantFox: " + gfUrl);
    if (DRY) continue;
    state.seen[key] = new Date().toISOString();
    const body = await draft(repo, Object.assign({}, issue, { url: issue.html_url }));
    if (body && isDraftSafe(body)) {
      if (!fs.existsSync(GF_INBOX)) fs.mkdirSync(GF_INBOX, { recursive: true });
      const slug = "grantfox--" + repo.replace("/", "__") + "--" + issue.number;
      fs.writeFileSync(path.join(GF_INBOX, slug + ".md"), [
        "# " + issue.title, "",
        "- Source: grantfox", "- Repo: " + repo,
        "- GrantFox: " + gfUrl, "- GitHub: " + issue.html_url,
        "- Comments: " + issue.comments, "- Labels: " + labels,
        "- Created: " + issue.created_at, "",
        "## Issue body", "",
        (issue.body || "(empty)").slice(0, 6000), "",
        "## Drafted application", "",
        body, "",
      ].join("\n"));
      console.log("     Draft saved to inbox/" + slug + ".md");
      urls.push({ url: gfUrl, title: issue.title });
    } else { console.log("     Draft failed - write this yourself"); }
    console.log("");
  }
  if (!DRY) fs.writeFileSync(GF_STATE, JSON.stringify(state, null, 2));
  if (urls.length) {
    console.log("Opening " + urls.length + " GrantFox page(s) in browser...");
    for (const u of urls) { openBrowser(u.url); await sleep(400); }
    console.log("Review drafts in inbox/, then apply on GrantFox.\n");
  }
}
const DRIPS_API = "https://wave-api.drips.network/api";
async function dripsFetch(p) {
  const res = await fetch(DRIPS_API + p, { headers: { Accept: "application/json", "User-Agent": "bounty-watcher" } });
  if (!res.ok) throw new Error("Drips API " + res.status + " for " + p);
  return res.json();
}
async function runDrips() {
  if (!fs.existsSync(DRIPS_CONFIG)) { console.log("[drips] drips-config.json not found."); return; }
  const config = JSON.parse(fs.readFileSync(DRIPS_CONFIG, "utf8"));
  if (!config.waveProgramId || config.waveProgramId === "YOUR_WAVEPROGRAMID") { console.log("[drips] waveProgramId not set."); return; }
  const state = fs.existsSync(DRIPS_STATE) ? JSON.parse(fs.readFileSync(DRIPS_STATE, "utf8")) : { seen: {}, applied: {} };
  const applied = loadApplied();
  const want = config.shortlist_size || 4;
  const maxR = config.max_per_repo || 4;
  const minPts = config.min_points || 200;
  if (!DRY) fs.mkdirSync(DRIPS_INBOX, { recursive: true });
  console.log("\n[drips] Searching for " + minPts + "+ point issues (priority: 800, 400)...");
  console.log("[drips] wave: " + config.waveProgramId.slice(0, 8) + "...");
  const allIssues = [];
  const spamRe = config.title_exclude_regex ? new RegExp(config.title_exclude_regex, "i") : null;
  let cursor = null;
  const dropped = { seen: 0, points: 0, spam: 0, repo: 0 };
  for (let page = 1; page <= (config.max_pages || 8); page++) {
    let u = "/issues?limit=100&waveProgramId=" + config.waveProgramId + "&state=open&applicantAssigned=false&sortBy=" + (config.sort_by || "updatedAt");
    if (cursor) u += "&cursor=" + encodeURIComponent(cursor);
    const data = await dripsFetch(u);
    const items = data.data || [];
    if (page === 1) console.log("[drips] " + (data.pagination && data.pagination.total || "?") + " open unassigned total");
    if (!items.length) break;
    for (const it of items) {
      const repo = it.repo && it.repo.gitHubRepoFullName || "unknown/unknown";
      const key = repo + "#" + it.gitHubIssueNumber;
      if (state.seen[key] || (state.applied && state.applied[key]) || applied[key]) { dropped.seen++; continue; }
      if ((it.points || 0) < minPts) { dropped.points++; continue; }
      if (spamRe && spamRe.test(it.title)) { dropped.spam++; continue; }
      allIssues.push(it);
    }
    cursor = data.pagination && data.pagination.nextCursor;
    if (!data.pagination || !data.pagination.hasNextPage || !cursor) break;
    await sleep(400);
  }
  allIssues.sort((a, b) => (b.points || 0) - (a.points || 0));
  // Group by repo for round-robin selection across repos
  const dripsByRepo = {};
  for (const it of allIssues) {
    const repo = it.repo && it.repo.gitHubRepoFullName || "unknown/unknown";
    if (!dripsByRepo[repo]) dripsByRepo[repo] = [];
    dripsByRepo[repo].push(it);
  }
  // Pick up to maxR issues per repo, prioritizing repos with more qualifying issues
  const kept = [];
  const dripsReposByCount = Object.keys(dripsByRepo).sort((a, b) => dripsByRepo[b].length - dripsByRepo[a].length);
  for (const repo of dripsReposByCount) {
    const issues = dripsByRepo[repo];
    const take = Math.min(maxR, issues.length);
    for (let i = 0; i < take && kept.length < want; i++) {
      kept.push(issues[i]);
    }
  }
  const d = Object.entries(dropped).filter(e => e[1]).map(e => e[1] + " " + e[0]);
  if (d.length) console.log("[drips] filtered: " + d.join(", "));
  console.log("[drips] " + kept.length + " issue(s) selected (sorted by points)\n");
  if (!kept.length) return;
  const urls = [];
  for (let i = 0; i < kept.length; i++) {
    const it = kept[i];
    const repo = it.repo.gitHubRepoFullName;
    const key = repo + "#" + it.gitHubIssueNumber;
    const gh = it.repo.gitHubRepoUrl + "/issues/" + it.gitHubIssueNumber;
    const dripsUrl = "https://www.drips.network/wave/" + (config.wave_slug || "stellar") + "/issues/" + it.id;
    console.log("  " + (i + 1) + ". " + key + ' -- "' + it.title + '"');
    console.log("     Points: " + it.points + " (x" + it.pointsMultiplier + ") | Apps: " + it.pendingApplicationsCount + " | Complexity: " + it.complexity);
    console.log("     Drips: " + dripsUrl);
    if (DRY) continue;
    state.seen[key] = new Date().toISOString();
    const body = await draft(repo, { title: it.title, body: it.body, url: gh });
    const slug = repo.replace("/", "__") + "--" + it.gitHubIssueNumber;
    fs.writeFileSync(path.join(DRIPS_INBOX, slug + ".md"), [
      "# " + it.title, "",
      "- Repo: " + repo, "- GitHub: " + gh,
      "- APPLY HERE: " + dripsUrl,
      "- Points: " + it.points + " (x" + it.pointsMultiplier + ")",
      "- Complexity: " + it.complexity,
      "- Pending applications: " + it.pendingApplicationsCount,
      "- Created: " + it.gitHubCreatedAt, "",
      "> Apply through the Drips link. A GitHub comment does NOT count.", "",
      "## Issue body", "",
      (it.body || "(empty)").slice(0, 6000), "",
      "## Drafted application (paste into Drips form)", "",
      body || "DRAFT-FAILED: write this yourself.", "",
    ].join("\n"));
    console.log("     Draft saved to inbox-drips/" + slug + ".md");
    urls.push({ url: dripsUrl, title: it.title });
    console.log("");
  }
  if (!DRY) fs.writeFileSync(DRIPS_STATE, JSON.stringify(state, null, 2));
  if (urls.length) {
    console.log("Opening " + urls.length + " Drips page(s) in browser...");
    for (const u of urls) { openBrowser(u.url); await sleep(400); }
    console.log("Review drafts in inbox-drips/, then apply on Drips.\n");
  }
}
function runApplied() {
  const sub = args[1] || "list";
  const refs = args.slice(2).filter(a => !a.startsWith("--"));
  const applied = loadApplied();
  switch (sub) {
    case "list": {
      const keys = Object.keys(applied).sort();
      if (!keys.length) { console.log("Nothing recorded."); return; }
      console.log(keys.length + " applied/excluded:\n");
      keys.forEach(k => { const v = applied[k]; console.log("  " + k.padEnd(52) + " " + (v.at || "").slice(0, 10) + "  " + (v.source || "") + (v.note ? "  (" + v.note + ")" : "")); });
      break;
    }
    case "add": {
      let note = null; const items = [...refs];
      const ni = items.indexOf("--note");
      if (ni !== -1) { note = items[ni + 1]; items.splice(ni, 2); }
      let n = 0;
      items.forEach(r => { const key = normaliseRef(r); if (!key || applied[key]) return; applied[key] = { at: new Date().toISOString(), source: "manual", note }; n++; });
      saveApplied(applied); console.log("Added " + n + ". Total: " + Object.keys(applied).length);
      break;
    }
    case "remove": {
      let n = 0;
      refs.forEach(r => { const k = normaliseRef(r); if (k && applied[k]) { delete applied[k]; n++; } });
      saveApplied(applied); console.log("Removed " + n + ". Total: " + Object.keys(applied).length);
      break;
    }
    case "import-posted": {
      const pd = path.join(DIR, "posted");
      if (!fs.existsSync(pd)) { console.error("No posted/ folder."); return; }
      let n = 0;
      fs.readdirSync(pd).filter(f => f.endsWith(".md")).forEach(f => {
        const t = fs.readFileSync(path.join(pd, f), "utf8");
        const m = t.match(/- Issue:\s*(\S+)/);
        if (!m) return; const key = normaliseRef(m[1]);
        if (!key || applied[key]) return;
        applied[key] = { at: new Date().toISOString(), source: "grantfox-posted" }; n++;
      });
      saveApplied(applied); console.log("Added " + n + ". Total: " + Object.keys(applied).length);
      break;
    }
    case "import-assigned": {
      try {
        const out = execFileSync("gh", ["issue", "list", "--assignee", "@me", "--state", "open", "--limit", "100", "--json", "number,title,url"], { encoding: "utf8" });
        let n = 0;
        JSON.parse(out).forEach(i => { const key = normaliseRef(i.url); if (!key || applied[key]) return; applied[key] = { at: new Date().toISOString(), source: "assigned" }; n++; });
        saveApplied(applied); console.log("Added " + n + ". Total: " + Object.keys(applied).length);
      } catch { console.error("gh failed."); }
      break;
    }
    case "prune": {
      const days = parseInt(refs[0] || "90", 10);
      const cutoff = Date.now() - days * 864e5; let n = 0;
      Object.entries(applied).forEach(([k, v]) => { if (new Date(v.at).getTime() < cutoff) { delete applied[k]; n++; } });
      saveApplied(applied); console.log("Pruned " + n + ". Total: " + Object.keys(applied).length);
      break;
    }
    default:
      console.log("Usage: node bounty.js applied <command>\n\n  list|add|remove|import-posted|import-assigned|prune");
  }
}
async function main() {
  switch (cmd) {
    case "grantfox": case "gf": await runGrantFox(); break;
    case "drips": await runDrips(); break;
    case "all": await runGrantFox(); await runDrips(); break;
    case "applied": runApplied(); break;
    case "drips-waves": {
      const data = await dripsFetch("/wave-programs?limit=100");
      console.log("\nAvailable wave programs:\n");
      (data.data || data).forEach(w => console.log("  " + w.id + "  " + (w.name || w.slug || "(unnamed)")));
      break;
    }
    default:
      console.log("bounty -- GrantFox + Drips Wave bounty automation\n\n  node bounty.js grantfox [--dry]   high-complexity issues, draft, open browser\n  node bounty.js drips [--dry]      200+ pt issues, draft, open browser\n  node bounty.js all [--dry]        both sources\n  node bounty.js applied ...        manage exclusion list\n  node bounty.js drips-waves        list wave IDs\n\nGrantFox: high-complexity labels, <5 comments, max 4/repo.\nDrips: 200+ points (800/400 prioritised), max 4/repo.\nDrafting: Gemini 2.0 Flash. Set GEMINI_API_KEY.");
  }
}
main().catch(e => { console.error("Error:", e.message); process.exit(1); });
