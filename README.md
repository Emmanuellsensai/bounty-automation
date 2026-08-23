# Bounty Automation

Watches GrantFox and Drips Wave for bounty issues, drafts applications with Gemini 2.0 Flash (free), and opens the browser to the exact pages where you apply.

**You stay in control** — nothing is posted automatically. You review drafts, then submit them yourself.

---

## What It Does

### GrantFox
- Searches GitHub for issues labeled `GrantFox OSS`
- Filters to high-complexity only (`Complexity: High`, `Complexity: Hardcore`, `Difficulty: Advanced`)
- Requires less than 5 comments (other applications)
- Max 4 issues per repo (avoids over-saturating)
- Drafts application with Gemini 2.0 Flash (free)
- Opens browser to the GrantFox issue page
- Saves draft to `inbox/` for review

### Drips Wave
- Pulls from Drips Wave API
- Filters to 200+ points (prioritizes 800 → 400 → 200+)
- Max 4 issues per repo
- Drafts with Gemini 2.0 Flash (free)
- Opens browser to the Drips issue page
- Saves draft to `inbox-drips/` for review

---

## Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org/)
- **GitHub account** — for creating a Personal Access Token
- **Google account** — for free Gemini API key

---

## Step 1: Get Your GitHub Personal Access Token

This token lets the tool search GitHub issues.

1. Go to **https://github.com/settings/tokens**
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Fill in:
   - **Note**: `bounty-automation`
   - **Expiration**: 90 days (or longer if you prefer)
   - **Scopes**: Check **`public_repo`** (under "repo" section)
4. Click **"Generate token"**
5. **Copy the token immediately** — you won't see it again! It starts with `ghp_`

> ⚠️ Keep this token secret. Never commit it to git.

---

## Step 2: Get Your Free Gemini API Key

This lets you draft applications for free using Google's Gemini 2.0 Flash model.

1. Go to **https://aistudio.google.com/apikey**
2. Click **"Create API key"**
3. Select a Google Cloud project (or create a new one — it's free)
4. Copy the API key. It starts with `AIza...`

> ✅ Gemini 2.0 Flash is free for personal use with generous rate limits.

---

## Step 3: Clone and Setup

### macOS / Linux

```bash
# Clone the repo
cd ~
git clone <YOUR_REPO_URL> bounty-automation
cd bounty-automation

# Copy config files
cp watcher/config.example.json watcher/config.json
cp watcher/drips-config.example.json watcher/drips-config.json
```

### Windows (PowerShell)

```powershell
# Clone the repo
cd ~
git clone <YOUR_REPO_URL> bounty-automation
cd bounty-automation

# Copy config files
Copy-Item watcher/config.example.json watcher/config.json
Copy-Item watcher/drips-config.example.json watcher/drips-config.json
```

---

## Step 4: Configure Your Settings

Edit `watcher/config.json` and set your GitHub username:

```json
{
  "github_username": "YOUR_GITHUB_USERNAME",
  "draft_provider": "gemini",
  "draft_model": "gemini-2.0-flash",
  ...
}
```

> Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username (lowercase).

---

## Step 5: Set Environment Variables

### Option A: Export in Terminal (temporary, current session only)

**macOS / Linux:**
```bash
export GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"
export GEMINI_API_KEY="AIza_YOUR_KEY_HERE"
```

**Windows (PowerShell):**
```powershell
$env:GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"
$env:GEMINI_API_KEY="AIza_YOUR_KEY_HERE"
```

### Option B: Add to Shell Profile (permanent)

**macOS / Linux (bash):**
```bash
echo 'export GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"' >> ~/.bashrc
echo 'export GEMINI_API_KEY="AIza_YOUR_KEY_HERE"' >> ~/.bashrc
source ~/.bashrc
```

**macOS (zsh — default on Mac):**
```bash
echo 'export GITHUB_TOKEN="ghp_YOUR_TOKEN_HERE"' >> ~/.zshrc
echo 'export GEMINI_API_KEY="AIza_YOUR_KEY_HERE"' >> ~/.zshrc
source ~/.zshrc
```

**Windows (PowerShell, permanent):**
```powershell
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_YOUR_TOKEN_HERE", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "AIza_YOUR_KEY_HERE", "User")
```

> ⚠️ After setting environment variables, **restart your terminal** for changes to take effect.

---

## Step 6: Test It Works

```bash
cd ~/bounty-automation/watcher

# Preview candidates (no drafting, no browser)
node bounty.js grantfox --dry
```

You should see output like:
```
[grantfox] Searching for high-complexity issues...
[grantfox] query: is:issue is:open no:assignee label:"GrantFox OSS" ...
[grantfox] 42 total; pulled 20
[grantfox] 4 high-complexity issue(s) selected

  1. owner/repo#123 -- "Fix bug in payment flow"
     Comments: 2 | Labels: Complexity: High, GrantFox OSS
     GrantFox: https://contribute.grantfox.xyz/org/owner/repo/issue/123
  ...
```

---

## Step 7: Run It For Real

```bash
# Draft applications and open GrantFox pages in browser
node bounty.js grantfox
```

**What happens:**
1. Searches for high-complexity GrantFox issues
2. Drafts applications using Gemini 2.0 Flash (free)
3. Saves drafts to `inbox/` folder
4. Opens browser to each GrantFox issue page

**Your workflow:**
1. Review the draft in `inbox/grantfox--owner__repo--123.md`
2. Edit if needed (fix any inaccuracies)
3. Paste into the GrantFox issue comment box
4. Submit!

---

## Available Commands

```bash
# GrantFox
node bounty.js grantfox           # Draft + open browser
node bounty.js grantfox --dry     # Preview only (no drafting)

# Drips (starts tomorrow when new wave begins)
node bounty.js drips              # Draft + open browser
node bounty.js drips --dry        # Preview only

# Both sources
node bounty.js all                # Run GrantFox + Drips
node bounty.js all --dry          # Preview both

# Manage applied/excluded issues
node bounty.js applied list       # Show exclusion list
node bounty.js applied add "owner/repo#123"    # Mark as applied
node bounty.js applied remove "owner/repo#123" # Unmark
node bounty.js applied prune 90   # Remove entries older than 90 days

# Drips utilities
node bounty.js drips-waves        # List available wave program IDs
```

---

## Configuration Options

### `watcher/config.json` (GrantFox)

```json
{
  "poll_minutes": 20,
  "github_username": "your_username",
  "draft_provider": "gemini",
  "draft_model": "gemini-2.0-flash",
  "per_source_limit": 4,          // Max issues to draft
  "max_per_repo": 4,              // Max issues per repository
  "max_comments": 5,              // Skip issues with this many+ comments
  "recent_days": 14,              // Only issues from last N days
  "title_exclude_regex": "...",   // Skip spam-like titles
  "sources": {
    "grantfox": {
      "enabled": true,
      "labels": ["GrantFox OSS"],
      "complexity_labels": [
        "Complexity: High",
        "Complexity: Hardcore",
        "Difficulty: Advanced",
        "High"
      ]
    }
  }
}
```

### `watcher/drips-config.json` (Drips Wave)

```json
{
  "waveProgramId": "YOUR_WAVE_PROGRAM_ID",  // Get from --waves command
  "wave_slug": "stellar",
  "shortlist_size": 4,
  "min_points": 200,
  "max_per_repo": 4,
  "draft_model": "gemini-2.0-flash"
}
```

> To find your `waveProgramId`, run: `node bounty.js drips-waves`

---

## File Structure

```
bounty-automation/
├── watcher/
│   ├── bounty.js                    # Main script (run this)
│   ├── config.json                  # GrantFox config (gitignored)
│   ├── drips-config.json            # Drips config (gitignored)
│   ├── config.example.json          # GrantFox config template
│   ├── drips-config.example.json    # Drips config template
│   ├── application-prompt.md        # How drafts are written
│   ├── applied.json                 # Exclusion list (gitignored)
│   ├── state.json                   # GrantFox state (gitignored)
│   ├── drips-state.json             # Drips state (gitignored)
│   ├── inbox/                       # GrantFox drafts (gitignored)
│   ├── inbox-drips/                 # Drips drafts (gitignored)
│   └── posted/                      # Posted applications (gitignored)
├── runner/                          # (Coming soon) Automated solver
├── skill/                           # Claude Code skill (for solver)
└── README.md
```

---

## Troubleshooting

### `GITHUB_TOKEN not set`
- Make sure you exported the environment variable
- Restart your terminal after setting it
- Verify with: `echo $GITHUB_TOKEN` (should show your token)

### `GEMINI_API_KEY not set`
- Get a free key from https://aistudio.google.com/apikey
- Export it: `export GEMINI_API_KEY="AIza..."`

### `config.json: Bad escaped character in JSON`
- The `title_exclude_regex` has invalid escaping
- Backslashes must be doubled in JSON: `\\(` not `\(`

### No issues found
- GrantFox may have no high-complexity issues right now
- Try adjusting `max_comments` or `recent_days` in config
- Check manually at https://contribute.grantfox.xyz

### Rate limited
- GitHub API has 60 requests/hour for unauthenticated, 5000 for authenticated
- The tool waits and retries automatically
- If still limited, wait an hour or check token scope

### Draft quality is poor
- Edit the draft in `inbox/` before posting
- The draft is a starting point — personalize it
- Remove any filler or inaccurate claims

---

## How Drafts Work

Drafts are written by Gemini 2.0 Flash (free) following the rules in `application-prompt.md`:

- **Plain, professional tone** — no emoji, no buzzwords
- **Short plan** — 3-5 concrete steps based on the actual issue
- **Honest** — no false claims about experience
- **Under 150 words**
- **Ready to paste** — no preamble, no explanation

You should always review and edit the draft before posting.

---

## Contributing

This tool is for personal use. Feel free to fork and modify for your own bounty hunting workflow.

---

## License

MIT
