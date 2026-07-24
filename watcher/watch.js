#!/usr/bin/env node
/**
 * bounty-watcher v2
 *
 * Finds UNASSIGNED bounty issues across GrantFox and Drips Wave by querying
 * GitHub's search API for the labels those platforms attach to synced issues.
 * Drafts an application for each and writes it to inbox/ for you to review.
 *
 * It never posts anything to GitHub. Applying stays a human action.
 *
 * Why search-by-label instead of scraping the platforms:
 *   - contribute.grantfox.xyz blocks automated requests (bot detection)
 *   - drips.network/wave renders issues client-side behind login
 *   - both sync issues to GitHub and label them, and GitHub search supports
 *     `no:assignee` natively, which is exactly the filter you want
 *
 * Requirements: Node 18+, GITHUB_TOKEN. ANTHROPIC_API_KEY optional (drafts).
 *
 * Usage:
 *   node watch.js            one poll cycle
 *   node watch.js --loop     poll forever
 *   node watch.js --dry      show what matched, write nothing
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const INBOX = path.join(__dirname, "inbox");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const APPLIED_PATH = path.join(__dirname, "applied.json");
const applied = fs.existsSync(APPLIED_PATH)
  ? JSON.parse(fs.readFileSync(APPLIED_PATH, "utf8")).applied || {}
  : {};

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { seen: {} };

const DRY = process.argv.includes("--dry");
const GH = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bounty-watcher",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghFetch(url, attempt = 0) {
  const res = await fetch(url, { headers });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining != null && Number(remaining) <= 2) {
    console.log(`  (search quota nearly spent: ${remaining} left this minute)`);
  }

  if (res.status === 403 || res.status === 429) {
    if (attempt < 3) {
      // Prefer the server's own guidance when it gives it.
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let wait = retryAfter ? retryAfter * 1000 : 0;
      if (!wait && reset) wait = Math.max(0, reset * 1000 - Date.now()) + 1000;
      if (!wait) wait = 30000 * (attempt + 1);
      console.log(`  rate limited, waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
      return ghFetch(url, attempt + 1);
    }
    throw new Error("GitHub search rate limit exceeded after retries");
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res.json();
}

/**
 * Derive a point value from an issue's labels using the configured map.
 * Returns null when nothing matches, meaning "unknown" rather than zero.
 */
function pointsFor(issue, source) {
  const map = config.sources[source].points_by_label || {};
  const labels = issue.labels.map((l) =>
    (typeof l === "string" ? l : l.name).toLowerCase()
  );
  // an explicit "200 points" style label wins if present
  for (const l of labels) {
    const m = l.match(/^(\d+)\s*points?$/);
    if (m) return parseInt(m[1], 10);
  }
  for (const [label, pts] of Object.entries(map)) {
    if (labels.includes(label.toLowerCase())) return pts;
  }
  return null;
}

function passesLocalFilters(issue, source) {
  const cfg = config.sources[source];
  const labels = issue.labels.map((l) =>
    (typeof l === "string" ? l : l.name).toLowerCase()
  );

  if (cfg.exclude_labels && cfg.exclude_labels.length) {
    const bad = cfg.exclude_labels.map((s) => s.toLowerCase());
    if (labels.some((l) => bad.includes(l))) return { ok: false, why: "label" };
  }

  // Filter out bulk auto-generated filler issues. These platforms attract
  // maintainers who mass-create near-identical padding issues ("buffer #12",
  // "part 3/40"), which are low value and crowd out real work.
  const spam = config.title_exclude_regex;
  if (spam && new RegExp(spam, "i").test(issue.title)) {
    return { ok: false, why: "spam-title" };
  }

  const pts = pointsFor(issue, source);
  if (cfg.min_points != null) {
    if (pts == null) {
      // Policy decides what to do when points cannot be derived from labels.
      const policy = cfg.unknown_points || config.unknown_points || "include";
      if (policy === "exclude") return { ok: false, why: "points-unknown" };
      return { ok: true, points: null, unknownPoints: true };
    }
    if (pts < cfg.min_points) return { ok: false, why: "points-low" };
  }
  return { ok: true, points: pts };
}

/** Build a GitHub search query for one source. */
function buildQuery(source) {
  const cfg = config.sources[source];
  const parts = ["is:issue", "is:open", "no:assignee"];
  for (const label of cfg.labels) parts.push(`label:"${label}"`);

  // Filter at the source rather than after fetching. GitHub search supports
  // both of these, which keeps us to a single request per source.
  const maxComments = cfg.max_comments != null ? cfg.max_comments : config.max_comments;
  if (maxComments != null) parts.push(`comments:<${maxComments}`);

  const days = cfg.recent_days != null ? cfg.recent_days : config.recent_days;
  if (days) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    parts.push(`created:>${since}`);
  }

  // Exclude anything you have already commented on. This is server-side and
  // survives deleting state.json, so you can never apply to the same issue twice.
  const me = config.github_username;
  if (me) parts.push(`-commenter:${me}`);

  if (cfg.extra_qualifiers) parts.push(cfg.extra_qualifiers);
  return parts.join(" ");
}

async function searchSource(source) {
  const q = buildQuery(source);
  const want = config.per_source_limit || 20;
  console.log(`\n[${source}] query: ${q}`);

  // One request. Ask for a buffer above the target so local filters (points,
  // exclude_labels) still leave us with roughly `want` candidates.
  const perPage = Math.min(100, want * 3);
  const url =
    `${GH}/search/issues?q=${encodeURIComponent(q)}` +
    `&sort=created&order=desc&per_page=${perPage}`;
  const data = await ghFetch(url);
  console.log(
    `[${source}] ${data.total_count} match(es); pulled ${data.items.length} most recent`
  );
  return data.items;
}

async function draftApplication(repo, issue) {
  const prompt = fs
    .readFileSync(path.join(__dirname, "application-prompt.md"), "utf8")
    .replace("{{REPO}}", repo)
    .replace("{{TITLE}}", issue.title)
    .replace("{{URL}}", issue.html_url)
    .replace("{{BODY}}", (issue.body || "").slice(0, 6000));

  // Drafting goes through the Claude Code CLI, which uses your existing
  // subscription. No API key required. Set CLAUDE_BIN if `claude` is not on
  // PATH for this process.
  const bin = process.env.CLAUDE_BIN || "claude";
  const args = ["-p"];
  // Drafting a short application is a small task; a cheap fast model is the
  // right fit and this is the highest-volume call in the pipeline.
  const model = config.draft_model || "haiku";
  if (model && model !== "default") args.push("--model", model);

  try {
    const out = execFileSync(bin, args, {
      input: prompt,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }).trim();
    return out || null;
  } catch (e) {
    const msg = (e.message || "").split("\n")[0];
    console.error(`  draft failed (${msg})`);
    return null;
  }
}

async function pollOnce() {
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is not set. Aborting.");
    process.exit(1);
  }
  if (!DRY) fs.mkdirSync(INBOX, { recursive: true });

  let written = 0;
  const limit = config.per_source_limit || 20;
  for (const source of Object.keys(config.sources)) {
    if (config.sources[source].enabled === false) continue;
    let items;
    try {
      items = await searchSource(source);
    } catch (e) {
      console.error(`[${source}] search failed: ${e.message}`);
      continue;
    }

    let kept = 0;
    const perRepo = {};
    const maxRepo = config.max_per_repo || 999;
    const dropped = { spam: 0, other: 0 };
    for (const issue of items) {
      if (kept >= limit) break;
      // repository_url looks like https://api.github.com/repos/owner/name
      const repo = issue.repository_url.split("/repos/")[1];
      const key = `${repo}#${issue.number}`;
      if (state.seen[key] || applied[key]) continue;

      const verdict = passesLocalFilters(issue, source);
      if (!verdict.ok) {
        if (verdict.why === "spam-title") dropped.spam++;
        else dropped.other++;
        state.seen[key] = new Date().toISOString();
        continue;
      }

      // Stop any single repo from flooding the batch.
      perRepo[repo] = (perRepo[repo] || 0) + 1;
      if (perRepo[repo] > maxRepo) continue;

      const ptsLabel = verdict.unknownPoints
        ? "points UNKNOWN (verify on platform)"
        : verdict.points != null
        ? `${verdict.points} pts`
        : "no points configured";
      console.log(
        `  NEW [${source}] ${key} (${ptsLabel}, ${issue.comments} comments) - ${issue.title}`
      );
      written++;
      kept++;
      if (DRY) continue;

      state.seen[key] = new Date().toISOString();
      const draft = await draftApplication(repo, issue);
      const slug = `${source}--${repo.replace("/", "__")}--${issue.number}`;
      const note = verdict.unknownPoints
        ? "> NOTE: point value could not be derived from labels. Check the\n> platform listing before applying if points matter to you.\n"
        : "";
      const out = [
        `# ${issue.title}`,
        ``,
        `- Source: ${source}`,
        `- Repo: ${repo}`,
        `- Issue: ${issue.html_url}`,
        `- Points: ${ptsLabel}`,
        `- Labels: ${issue.labels.map((l) => l.name || l).join(", ") || "none"}`,
        `- Created: ${issue.created_at}`,
        `- Comments so far: ${issue.comments}`,
        `- Assignee: none (verified via GitHub no:assignee)`,
        ``,
        note,
        `## Issue body`,
        ``,
        (issue.body || "(empty)").slice(0, 6000),
        ``,
        `## Drafted application (REVIEW AND EDIT BEFORE POSTING)`,
        ``,
        draft ||
          "DRAFT-FAILED: write the application yourself from the issue above. Do not post this line.",
        ``,
      ].join("\n");
      fs.writeFileSync(path.join(INBOX, `${slug}.md`), out);
    }

    if (dropped.spam || dropped.other) {
      console.log(
        `[${source}] filtered out ${dropped.spam} bulk/filler, ${dropped.other} other`
      );
    }
  }

  if (!DRY) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(
    `\n${written} new candidate(s)` +
      (DRY ? " (dry run, nothing written)" : ` written to ${INBOX}`)
  );
}

async function main() {
  const loop = process.argv.includes("--loop");
  do {
    try {
      await pollOnce();
    } catch (e) {
      console.error("Poll failed:", e.message);
    }
    if (loop) {
      const mins = config.poll_minutes || 15;
      console.log(`Sleeping ${mins} min...`);
      await sleep(mins * 60000);
    }
  } while (loop);
}

main();
