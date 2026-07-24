# Bounty automation

Watches GrantFox and Drips Wave for bounty issues, drafts applications, and
(soon) drives Claude Code through a gated recon → design → build workflow on
assigned issues. **You always press the last button** — nothing is committed,
pushed, or posted without your explicit action.

## What is inside

```
watcher/    Poll GitHub + Drips for open bounty issues, draft applications
runner/     Take an assigned issue through recon → design → build (uncommitted)
skill/      The workflow Claude Code follows (install to ~/.claude/skills)
```

## What you need

- **Node.js 18+** and **git**
- **Claude Code CLI** (this uses your existing subscription; no API key)
- **GitHub CLI** (`gh`) — for reading and posting comments
- A **GitHub personal access token** with `public_repo` scope

## Install — Windows

1. Install prerequisites:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   winget install GitHub.cli
   irm https://claude.ai/install.ps1 | iex
   ```
   Close and reopen the terminal so PATH picks up the new binaries.

2. Clone this repo and put the pieces where the scripts expect them:
   ```powershell
   git clone <YOUR_REPO_URL> $HOME\bounty-automation
   Copy-Item $HOME\bounty-automation\watcher\config.example.json      $HOME\bounty-automation\watcher\config.json
   Copy-Item $HOME\bounty-automation\watcher\drips-config.example.json $HOME\bounty-automation\watcher\drips-config.json
   New-Item -Type Directory -Force $HOME\.claude\skills\bounty-solver\references | Out-Null
   Copy-Item $HOME\bounty-automation\skill\SKILL.md                   $HOME\.claude\skills\bounty-solver\SKILL.md
   Copy-Item $HOME\bounty-automation\skill\references\*.md            $HOME\.claude\skills\bounty-solver\references\
   Copy-Item $HOME\bounty-automation\runner\settings.json             $HOME\.claude\settings.json
   ```

3. Set your token and log in:
   ```powershell
   [Environment]::SetEnvironmentVariable("GITHUB_TOKEN","ghp_YOUR_TOKEN","User")
   gh auth login
   claude          # opens the CLI, log in through the browser, then Ctrl+C to exit
   ```
   Close and reopen the terminal.

4. Allow local PowerShell scripts:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   Get-ChildItem $HOME\bounty-automation -Recurse -Filter *.ps1 | Unblock-File
   ```

5. Edit both configs before first run:
   - `watcher\config.json` — set `github_username` to your GitHub login.
   - `watcher\drips-config.json` — set `waveProgramId` (see below).

## Install — Ubuntu / WSL

1. Install prerequisites:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm git
   sudo apt install -y gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/etc/apt/keyrings/githubcli.gpg && \
     echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list && \
     sudo apt update && sudo apt install gh)
   curl -fsSL https://claude.ai/install.sh | bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

2. Clone and place the pieces:
   ```bash
   git clone <YOUR_REPO_URL> ~/bounty-automation
   cp ~/bounty-automation/watcher/config.example.json      ~/bounty-automation/watcher/config.json
   cp ~/bounty-automation/watcher/drips-config.example.json ~/bounty-automation/watcher/drips-config.json
   mkdir -p ~/.claude/skills/bounty-solver/references
   cp ~/bounty-automation/skill/SKILL.md                   ~/.claude/skills/bounty-solver/
   cp ~/bounty-automation/skill/references/*.md            ~/.claude/skills/bounty-solver/references/
   cp ~/bounty-automation/runner/settings.json             ~/.claude/settings.json
   chmod +x ~/bounty-automation/runner/solve.sh
   ```

3. Log in:
   ```bash
   export GITHUB_TOKEN=ghp_YOUR_TOKEN
   echo 'export GITHUB_TOKEN=ghp_YOUR_TOKEN' >> ~/.bashrc
   gh auth login
   claude          # log in through the browser, then Ctrl+C
   ```

4. Edit both configs — same as Windows step 5 above.

## Find your `waveProgramId`

The Drips Wave is keyed by a UUID. To find it:

1. Open `drips.network/wave/stellar/issues` in your browser.
2. Open DevTools → Network → filter by `Fetch/XHR` → reload.
3. Find a request named `issues?limit=…&waveProgramId=…`.
4. Copy the `waveProgramId` value into `watcher/drips-config.json`.

## Daily loop

```bash
cd ~/bounty-automation/watcher     # (or $HOME\bounty-automation\watcher on Windows)

node watch.js --dry                # preview GrantFox candidates
node watch.js                      # write drafts to inbox/
./review.ps1                       # (Windows) post applications, Enter/skip/edit per item

node drips.js --dry                # preview Drips Wave shortlist
node drips.js                      # write to inbox-drips/
# Drips: open each 'APPLY HERE' link, paste the draft into the Drips form
node applied.js add "owner/repo#123" "owner/repo#456"  # record what you applied to
```

`applied.json` is shared: once an issue is in it, neither watcher will surface
it again.

## Useful commands

```
node applied.js list                    show everything recorded
node applied.js add <ref>...            record applications (owner/repo#N or URL)
node applied.js import-posted           import from the review.ps1 posted/ folder
node applied.js import-assigned         import your open GitHub assignments
node applied.js prune 90                drop entries older than N days

node drips.js --waves                   list Drips wave IDs (to switch waves)
node drips.js --dry                     shortlist without writing
```

## What is not automated on purpose

- **Applying.** Comments post publicly under your name. `review.ps1` still needs
  you to press Enter for each item so quality stays in your hands.
- **The recon verdict.** Templated issues sometimes describe code that does not
  exist. Reading the recon before letting the solver design a fix is the gate
  that keeps PRs mergeable.
- **Committing.** The solver stops with everything uncommitted. You review the
  diff, commit and push by hand.

## Directory layout after setup

```
~/bounty-automation/
├── watcher/
│   ├── watch.js, drips.js, applied.js       run these
│   ├── review.ps1, cleanup.ps1              apply / repair posted comments
│   ├── application-prompt.md                how drafts are written
│   ├── config.json, drips-config.json       your local configs (gitignored)
│   ├── applied.json, state.json             local state (gitignored)
│   └── inbox/, inbox-drips/, posted/        working folders (gitignored)
├── runner/
│   ├── assigned.ps1, solve.ps1, solve.sh    solve-side (in progress)
│   ├── settings.json                        Claude Code permission allowlist
│   └── repos.json                           you map assigned repos → clones
└── skill/                                   installed to ~/.claude/skills/bounty-solver
```

## Troubleshooting

- **`claude: command not found`** — Windows: check `C:\Users\<you>\.local\bin` is
  on PATH. Ubuntu: run `export PATH="$HOME/.local/bin:$PATH"`.
- **`draft failed` / drafts empty** — you have `ANTHROPIC_API_KEY` set; unset it
  so the CLI falls back to your subscription.
- **`GITHUB_TOKEN not set`** — reopen the terminal after setting the env var.
- **Drips search errors** — verify `waveProgramId` in `drips-config.json`;
  re-copy it from DevTools if the wave changed.
