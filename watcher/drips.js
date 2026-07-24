#!/usr/bin/env node
/**
 * drips.js - pull real issues from the live Drips Wave, not the GitHub label.
 *
 * The GitHub `Stellar Wave` label is applied to every issue ever synced, across
 * all waves. The Drips API is keyed by waveProgramId, so it returns only what is
 * actually claimable now, with real point values and real applicant counts.
 *
 * The API is public: no token, no cookie.
 *
 * IMPORTANT: applying to a Drips issue must be done through the Drips UI. A
 * GitHub comment does NOT register as an application and will not count against
 * your slots. This script therefore writes a SHORTLIST for you to work from,
 * with a direct link to each issue on drips.network.
 *
 * Usage:
 *   node drips.js            write shortlist to inbox-drips/
 *   node drips.js --dry      print matches only
 *   node drips.js --waves    list available wave programs and their IDs
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "drips-config.json");
const STATE_PATH = path.join(__dirname, "drips-state.json");
const OUT = path.join(__dirname, "inbox-drips");

const API = "https://wave-api.drips.network/api";
const DRY = process.argv.includes("--dry");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const APPLIED_PATH = path.join(__dirname, "applied.json");
const sharedApplied = fs.existsSync(APPLIED_PATH)
  ? JSON.parse(fs.readFileSync(APPLIED_PATH, "utf8")).applied || {}
  : {};

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { seen: {}, applied: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { Accept: "application/json", "User-Agent": "bounty-watcher" },
  });
  if (!res.ok) throw new Error(`Drips API ${res.status} for ${pathname}`);
  return res.json();
}

async function listWaves() {
  const data = await api("/wave-programs?limit=100");
  const rows = data.data || data;
  console.log("\nAvailable wave programs:\n");
  for (const w of rows) {
    console.log(`  ${w.id}  ${w.name || w.slug || "(unnamed)"}`);
  }
  console.log("\nPut the one you want in drips-config.json as waveProgramId.\n");
}

/** Fetch pages until we have enough candidates or run out. */
async function fetchIssues() {
  const wave = config.waveProgramId;
  const want = config.shortlist_size || 20;
  const maxPages = config.max_pages || 8;
  const perPage = 100;
  const kept = [];
  const perRepo = {};
  let dropped = { applicants: 0, points: 0, spam: 0, old: 0, repo: 0, seen: 0 };
  let cursor = null;

  for (let page = 1; page <= maxPages && kept.length < want; page++) {
    // state=open and applicantAssigned=false filter server-side
    let url =
      `/issues?limit=${perPage}&waveProgramId=${wave}` +
      `&state=open&applicantAssigned=false&sortBy=${config.sort_by || "updatedAt"}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const data = await api(url);
    const items = data.data || [];
    if (page === 1) {
      console.log(`Wave has ${data.pagination?.total ?? "?"} open unassigned issue(s)`);
    }
    if (!items.length) break;

    for (const it of items) {
      if (kept.length >= want) break;
      const repo = it.repo?.gitHubRepoFullName || "unknown/unknown";
      const key = `${repo}#${it.gitHubIssueNumber}`;

      if (state.seen[key] || state.applied[key] || sharedApplied[key]) { dropped.seen++; continue; }
      if (it.assignedApplicant || (it.assignees && it.assignees.length)) continue;

      // Competition: the single most useful signal the API gives us.
      if (config.max_pending_applications != null &&
          it.pendingApplicationsCount > config.max_pending_applications) {
        dropped.applicants++; continue;
      }
      if (config.min_points != null && (it.points ?? 0) < config.min_points) {
        dropped.points++; continue;
      }
      if (config.title_exclude_regex &&
          new RegExp(config.title_exclude_regex, "i").test(it.title)) {
        dropped.spam++; continue;
      }
      if (config.recent_days) {
        const ageD = (Date.now() - new Date(it.gitHubCreatedAt)) / 864e5;
        if (ageD > config.recent_days) { dropped.old++; continue; }
      }
      perRepo[repo] = (perRepo[repo] || 0) + 1;
      if (perRepo[repo] > (config.max_per_repo || 99)) { dropped.repo++; continue; }

      kept.push(it);
    }

    cursor = data.pagination?.nextCursor;
    if (!data.pagination?.hasNextPage || !cursor) break;
    await sleep(400);
  }

  const d = Object.entries(dropped).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
  if (d.length) console.log(`Filtered out: ${d.join(", ")}`);
  return kept;
}

function draft(issue) {
  const repo = issue.repo.gitHubRepoFullName;
  const url = `${issue.repo.gitHubRepoUrl}/issues/${issue.gitHubIssueNumber}`;
  const prompt = fs
    .readFileSync(path.join(__dirname, "application-prompt.md"), "utf8")
    .replace("{{REPO}}", repo)
    .replace("{{TITLE}}", issue.title)
    .replace("{{URL}}", url)
    .replace("{{BODY}}", (issue.body || "").slice(0, 2500));

  const bin = process.env.CLAUDE_BIN || "claude";
  const args = ["-p"];
  const model = config.draft_model || "haiku";
  if (model && model !== "default") args.push("--model", model);
  try {
    return execFileSync(bin, args, {
      input: prompt, encoding: "utf8", timeout: 180000,
      maxBuffer: 10 * 1024 * 1024, windowsHide: true,
    }).trim() || null;
  } catch (e) {
    console.error(`  draft failed (${(e.message || "").split("\n")[0]})`);
    return null;
  }
}

async function main() {
  if (process.argv.includes("--waves")) return listWaves();
  if (!config.waveProgramId) {
    console.error("Set waveProgramId in drips-config.json (run --waves to list).");
    process.exit(1);
  }
  if (!DRY) fs.mkdirSync(OUT, { recursive: true });

  const issues = await fetchIssues();
  console.log(`\n${issues.length} shortlisted:\n`);

  for (const it of issues) {
    const repo = it.repo.gitHubRepoFullName;
    const key = `${repo}#${it.gitHubIssueNumber}`;
    const gh = `${it.repo.gitHubRepoUrl}/issues/${it.gitHubIssueNumber}`;
    const dripsUrl = `https://www.drips.network/wave/${config.wave_slug || "stellar"}/issues/${it.id}`;

    console.log(
      `  ${key}  ${it.points}pts  ${it.pendingApplicationsCount} applicant(s)  ${it.complexity}`
    );
    console.log(`     ${it.title}`);
    if (DRY) continue;

    state.seen[key] = new Date().toISOString();
    const body = draft(it);
    const slug = `${repo.replace("/", "__")}--${it.gitHubIssueNumber}`;
    fs.writeFileSync(
      path.join(OUT, `${slug}.md`),
      [
        `# ${it.title}`, ``,
        `- Repo: ${repo}`,
        `- GitHub: ${gh}`,
        `- APPLY HERE: ${dripsUrl}`,
        `- Points: ${it.points} (multiplier ${it.pointsMultiplier})`,
        `- Complexity: ${it.complexity}`,
        `- Pending applications: ${it.pendingApplicationsCount}`,
        `- Created: ${it.gitHubCreatedAt}`,
        `- Labels: ${(it.labels || []).map((l) => l.name).join(", ") || "none"}`,
        ``,
        `> Apply through the Drips link above. A GitHub comment does NOT count`,
        `> as an application and will not use or fill a slot.`,
        ``,
        `## Issue body`, ``, (it.body || "(empty)").slice(0, 6000), ``,
        `## Drafted application (paste into the Drips form after reviewing)`, ``,
        body || "DRAFT-FAILED: write this one yourself.", ``,
      ].join("\n")
    );
  }

  if (!DRY) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`\nWritten to ${OUT}`);
    console.log(`Apply via the Drips link in each file, then mark them applied:`);
    console.log(`  node drips.js --applied "owner/repo#123" "owner/repo#456"`);
  }
}

// mark issues as applied so they never resurface
const appliedIdx = process.argv.indexOf("--applied");
if (appliedIdx !== -1) {
  const refs = process.argv.slice(appliedIdx + 1).filter((a) => !a.startsWith("--"));
  for (const r of refs) state.applied[r] = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`Marked ${refs.length} as applied.`);
} else {
  main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
}
