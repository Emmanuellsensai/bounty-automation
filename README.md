# Bounty automation

Watches GrantFox and Drips Wave for bounty issues, drafts applications with Gemini free, and opens the browser to the exact pages where you apply.

## Quick start

    cd ~/bounty-automation/watcher
    node bounty.js all --dry    # preview
    node bounty.js grantfox     # GrantFox: high-complexity, draft, open browser
    node bounty.js drips        # Drips: 200+ pts, draft, open browser
    node bounty.js all          # both

## How it works

### GrantFox
- Searches GitHub for issues labeled GrantFox OSS
- Filters to high-complexity only (Complexity: High, Complexity: Hardcore, Difficulty: Advanced, High)
- Requires less than 5 comments (applications)
- Max 4 issues per repo
- Drafts with Gemini 2.0 Flash (free)
- Opens browser to the GrantFox issue page
- Saves drafts to inbox/

### Drips Wave
- Pulls from Drips Wave API
- Filters to 200+ points, sorted by points desc (800 > 400 > 200+)
- Max 4 issues per repo
- Drafts with Gemini free
- Opens browser to the Drips issue page
- Saves drafts to inbox-drips/

## Commands

    node bounty.js grantfox [--dry]
    node bounty.js drips [--dry]
    node bounty.js all [--dry]
    node bounty.js applied list|add|remove|prune
    node bounty.js drips-waves

## Config

Edit watcher/config.json (GrantFox) and watcher/drips-config.json (Drips).
Set GITHUB_TOKEN and GEMINI_API_KEY env vars.
See config.example.json for format.
