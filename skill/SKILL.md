---
name: bounty-solver
description: Solve an assigned open-source bounty issue (GrantFox, Drips, Stellar Wave, or any GitHub issue) through a gated workflow - verify the issue against real code, design, implement, verify, and stop before committing. Use this whenever the user references working on an assigned issue, a bounty, a GrantFox or Drips task, or says something like "let's work on issue #N", "I got assigned this", or pastes an issue body and asks to build it. Also use when reviewing whether an issue is worth taking on.
---

# Bounty Solver

A phased workflow for turning an assigned issue into a mergeable PR without
fabricating work or producing unreviewable diffs.

## Core rule

**Never write code before verifying the issue matches the real codebase.**

Auto-generated and templated issues are common in bounty programs. They
frequently describe code that does not exist, cite line numbers past the end of
a file, or ask you to test features that were never implemented. Building
against a false description produces a PR that gets rejected on sight, with the
contributor's name on it.

## Phases

Work through these in order. **Stop at each gate and wait for the user.**

### Phase 0 — Recon (no code)

1. Read the issue. If `gh` is available, `gh issue view <N>`.
2. Open **every** file and line range the issue cites. Confirm the described
   code actually exists and matches. Quote the real lines.
3. Establish the repo's real conventions before proposing anything:
   - test runner and how tests are invoked (read `package.json` scripts)
   - where tests live and how they are named (follow the **actual** convention,
     not what the issue claims)
   - how existing similar features are built - mirror them, do not invent
   - what is already a dependency (never add a new one without asking)
4. Report a short summary: does the described problem actually exist?

**STOP if the issue does not match reality.** Report exactly how it differs and
ask how to proceed. Do not invent a metadata format, fabricate a missing
component, or rewrite existing code to match a false description. See
`references/red-flags.md`.

### Phase 1 — Design

Propose the **minimal** change that satisfies the acceptance criteria, fitted to
the code found in Phase 0. Include:

- exact files to add or change
- the public surface (function signatures, endpoints, types)
- test cases to be written
- anything deliberately out of scope

Flag scope: if the change exceeds roughly 40 test cases or touches more than a
handful of unrelated files, propose splitting into multiple PRs rather than
shipping one oversized diff.

**STOP and wait for approval.**

### Phase 2 — Implement

- Match existing repo patterns exactly. No new dependencies.
- **Never modify application source to make a test pass.** If a test exposes a
  real bug, report it rather than weakening the assertion or changing code.
- Use obviously fake values in fixtures. Never real or production-shaped
  secrets, keys, or credentials.
- Never log secrets or derived key material in code that handles them.

Then verify, running the repo's own scripts:

- typecheck, lint, tests, build (whichever exist)
- formatter in check mode on **every** file touched, including files outside the
  default glob - CI format checks often cover paths the local format script misses
- tests must pass regardless of how they are invoked; a test whose result depends
  on ambient environment is brittle and must be fixed

**STOP. Do not commit. Do not push.** Show the diff summary and full check
output, everything left unstaged. The user commits by hand.

## Verifying a red CI

Before assuming a failure is yours, compare against the base branch:

```
git checkout main && <test command> 2>&1 | grep -E "Tests:|Test Suites:"
git checkout <branch> && <test command> 2>&1 | grep -E "Tests:|Test Suites:"
```

If the failure counts match, the breakage is pre-existing and is not the PR's to
fix. Say so with the numbers, and do not absorb unrelated repo debt into a scoped
PR. If the branch fails worse than base, that difference is real - investigate it.

## Writing the PR

Read `references/pr-template.md`. The description must be honest about what was
actually done, including anything that diverged from the issue, anything left
deliberately unfixed, and the exact scope of verification. Pre-empting a
reviewer's questions is what gets a PR merged.

Use `Closes #N` only when the PR fully resolves the issue. For one slice of a
multi-part issue, use "Partially addresses #N".
