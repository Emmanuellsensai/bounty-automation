#!/usr/bin/env node
/**
 * check-repos.js — Show GrantFox repos and their labels to understand the landscape
 */
const fs = require("fs");
const path = require("path");

const GH_API = "https://api.github.com";
const ghHeaders = () => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bounty-checker",
});

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN not set");
    process.exit(1);
  }

  console.log("Fetching GrantFox issues (first 100)...\n");
  
  const q = 'is:issue is:open no:assignee label:"GrantFox OSS" comments:<10 created:>2026-07-01 -label:"wontfix" -label:"duplicate" -label:"invalid"';
  const data = await ghFetch(`${GH_API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=100`);
  
  console.log(`Total: ${data.total_count} issues (showing first ${data.items.length})\n`);
  
  // Group by repo
  const byRepo = {};
  for (const issue of data.items) {
    const repo = issue.repository_url.split("/repos/")[1];
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push({
      number: issue.number,
      title: issue.title,
      comments: issue.comments,
      labels: issue.labels.map(l => l.name || l),
    });
  }
  
  // Show repos and their issues
  const repos = Object.keys(byRepo).sort();
  console.log(`Found ${repos.length} repos with GrantFox issues:\n`);
  
  const complexityLabels = ["complexity: high", "complexity: hardcore", "difficulty: advanced", "high"];
  
  for (const repo of repos) {
    const issues = byRepo[repo];
    const highComplexity = issues.filter(i => 
      i.labels.some(l => complexityLabels.includes(l.toLowerCase()))
    );
    
    console.log(`📦 ${repo} (${issues.length} issues, ${highComplexity.length} high-complexity)`);
    
    for (const issue of issues) {
      const isHigh = issue.labels.some(l => complexityLabels.includes(l.toLowerCase()));
      const marker = isHigh ? "⭐" : "  ";
      console.log(`  ${marker} #${issue.number}: ${issue.title.slice(0, 60)}`);
      console.log(`      Comments: ${issue.comments} | Labels: ${issue.labels.join(", ")}`);
    }
    console.log("");
  }
  
  // Summary
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════\n");
  
  let totalHigh = 0;
  for (const repo of repos) {
    const high = byRepo[repo].filter(i => 
      i.labels.some(l => complexityLabels.includes(l.toLowerCase()))
    );
    totalHigh += high.length;
  }
  
  console.log(`Total repos: ${repos.length}`);
  console.log(`Total issues: ${data.items.length}`);
  console.log(`High-complexity issues: ${totalHigh}`);
  console.log(`\nIf high-complexity count is low, most GrantFox issues don't have complexity labels.`);
  console.log(`Consider relaxing the complexity filter or waiting for more labeled issues.`);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
