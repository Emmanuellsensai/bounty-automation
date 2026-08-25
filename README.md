# Bounty Automation

Automates bounty hunting on **GrantFox** and **Drips Wave**. Searches for open issues, drafts applications with AI (Gemini 2.5 Flash, free), and opens browser tabs so you can submit.

**Nothing is posted automatically.** You review drafts, then submit them yourself.

---

## Quick Start

### 1. Get API Keys

**GitHub Token** (for searching issues):
1. Go to https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Name: `bounty-automation`, Expiry: 90 days
4. Check scope: **`public_repo`**
5. Copy the token (starts with `ghp_`)

**Gemini API Key** (for drafting applications):
1. Go to https://aistudio.google.com/apikey
2. Click **Create API key**
3. Copy it (starts with `AIza...`)

### 2. Set Environment Variables

**Linux / macOS:**
```bash
export GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"
export GEMINI_API_KEY="AIza_YOUR_KEY_HERE"
```

**Windows (PowerShell):**
```powershell
$env:GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"
$env:GEMINI_API_KEY="AIza_YOUR_KEY_HERE"
```

For permanent setup, add those lines to your shell profile (`~/.bashrc`, `~/.zshrc`, or PowerShell `$PROFILE`).

### 3. Configure

Edit `watcher/config.json` and set your GitHub username:
```json
{
  "github_username": "YOUR_GITHUB_USERNAME"
}
```

### 4. Configure Drips Wave

To use the Drips Wave source, you need a **wave program ID**. This identifies which bounty wave you want to track (e.g. Stellar, Solana).

Run this command to list all active wave programs and their IDs:

```bash
node bounty.js drips-waves
```

This prints all active wave programs with their IDs, e.g.:

```
Available wave programs:

  fdc01c95-806f-4b6a-998b-a6ed37e0d81b  Stellar

Put the one you want in drips-config.json as waveProgramId.
```

**Then set it in your config:**

If `drips-config.json` doesn't exist yet, copy the example:

```bash
cp watcher/drips-config.example.json watcher/drips-config.json
```

Edit `watcher/drips-config.json` and replace the placeholder:

```json
{
  "waveProgramId": "PASTE_THE_ID_HERE"
}
```

**How to choose a wave:** Each wave targets a specific ecosystem (e.g. Stellar, Solana) with its own reward pool and point system. Check https://www.drips.network/wave to see which waves are active and what the payout structure looks like before picking one.


---

## Usage

See all available issues without drafting or opening anything:

```bash
node bounty.js grantfox --dry       # GrantFox issues only
node bounty.js drips --dry          # Drips issues only
node bounty.js all --dry            # Both
```

### Pick Specific Issues

Use `--pick` to select which issues to process:

```bash
# Interactive: shows list, then prompts for numbers
node bounty.js grantfox --dry --pick

# Auto-select: skip the prompt
node bounty.js grantfox --dry --pick 3,8,22
```

Numbers are the **list position** (1, 2, 3...) not the GitHub issue number.

After selecting:
- Drafts are saved to `inbox/` (GrantFox) or `inbox-drips/` (Drips)
- Browser tabs open to the GrantFox/Drips application pages

### Run Without Preview

Draft applications and open browser tabs directly (no selection prompt):

```bash
node bounty.js grantfox             # Draft + open browser
node bounty.js drips                # Draft + open browser
node bounty.js all                  # Both
```

---

## Commands

| Command | What It Does |
|---------|-------------|
| `node bounty.js grantfox --dry` | List GrantFox issues (no draft) |
| `node bounty.js grantfox --dry --pick` | List + pick specific issues |
| `node bounty.js grantfox --dry --pick 3,8,22` | List + auto-select issues |
| `node bounty.js grantfox` | Draft all + open browser |
| `node bounty.js grantfox --pick 3,8` | Draft selected + open browser |
| `node bounty.js drips --dry` | List Drips issues (no draft) |
| `node bounty.js drips` | Draft all + open browser |
| `node bounty.js all --dry` | List both sources |
| `node bounty.js all --pick 1,5` | Pick from both sources |

### Exclusion List

Track which issues you've already applied to:

```bash
node bounty.js applied list                          # Show all
node bounty.js applied add "owner/repo#123"          # Mark as applied
node bounty.js applied remove "owner/repo#123"       # Unmark
node bounty.js applied prune 90                      # Remove entries older than 90 days
```

### Utilities

```bash
node bounty.js drips-waves        # List Drips wave program IDs
```

---

## How It Works

### GrantFox
- Searches GitHub for issues labeled `GrantFox OSS`
- Filters to high-complexity issues (priority, security, performance labels)
- Skips issues with 5+ comments (too many applicants)
- Max 4 issues per repository
- Only shows unassigned issues

### Drips Wave
- Pulls from the Drips Wave API
- Filters to 200+ point issues
- Prioritizes easy/medium complexity (GrantFox handles hard/complex)
- Max 3 issues per repository, 15 per run
- Only shows unassigned issues

### Drafting
- Uses Gemini 2.5 Flash (free tier)
- Reads the issue body and generates a detailed, specific application
- Drafts are 250-400 words with concrete implementation plans
- Saved as `.md` files in `inbox/` or `inbox-drips/`

---

## Your Workflow

1. Run with `--dry --pick` to see available issues
2. Pick the ones you want (by list number)
3. Review each draft in `inbox/` — edit if needed
4. Browser opens the GrantFox/Drips page for each
5. Paste your draft and submit

---

## File Structure

```
bounty-automation/
├── watcher/
│   ├── bounty.js                    # Main script
│   ├── config.json                  # GrantFox config
│   ├── drips-config.json            # Drips config
│   ├── application-prompt.md        # Draft prompt template
│   ├── applied.json                 # Exclusion list
│   ├── state.json                   # GrantFox state
│   ├── drips-state.json             # Drips state
│   ├── inbox/                       # GrantFox drafts
│   └── inbox-drips/                 # Drips drafts
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `GITHUB_TOKEN not set` | Export it and restart terminal |
| `GEMINI_API_KEY not set` | Get free key from https://aistudio.google.com/apikey |
| `Gemini API 404` | API key may be invalid — regenerate it |
| No issues found | GrantFox may have no qualifying issues right now |
| Draft is poor | Edit the `.md` file in `inbox/` before posting |
| Rate limited | Tool retries automatically — wait if needed |
| JSON parse error | Check `config.json` — backslashes must be doubled (`\\\\`) |
| `waveProgramId not set` | Run `node bounty.js drips-waves` to list IDs, then set it in `drips-config.json` |

---

## License

MIT
