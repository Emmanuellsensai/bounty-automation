# Red flags: when an issue does not match reality

Bounty programs generate issues in bulk, often from templates or a model that
never read the repo. These are the observed failure patterns. Each one is a
**STOP**, not a puzzle to work around.

## The described code does not exist

- The cited file has fewer lines than the cited line number.
- A repo-wide grep for the named symbols, classes, or patterns returns nothing.
- The named component exists but does something entirely different (e.g. the
  issue describes an auto-saving form; the file is a QR-code wizard).

Verify with an exhaustive search before concluding it exists. Check the current
default branch - a shallow or cached clone can serve stale code. Fetch fresh and
confirm the latest commit.

## The premise is from a different stack

- The issue assumes config that this project does not use (e.g. a Tailwind v3
  `purge` key and `tailwind.config.ts` safelist, in a Tailwind v4 project that
  has neither).
- The blueprint references an API, file, or build step that this project
  replaced or never had.

The framing may be wrong while the underlying *intent* is still valid. Say so
explicitly, and propose the equivalent for the actual stack rather than editing
files that do not exist.

## The issue asks you to test features that were never built

Common in "add test coverage" issues on security-sensitive routes: it asks for
tests proving rate limiting, audit logging, or role checks that the route does
not implement.

This is a **feature request wearing a test-coverage label**. Do not write tests
that assert nothing, and do not silently implement security controls under a
testing PR. Surface the gap and let the user decide whether to scope it as
implementation plus tests.

## Mislabelled or misdiagnosed

A build-time static-analysis problem labelled a race condition; a cursor
pagination bug labelled a performance issue. Harmless in itself, but a signal
the issue was not written by someone who read the code. Raise the labelling
gently and do not echo a wrong diagnosis back in the PR description.

## Overlap with existing work

Before starting, check whether the work is already done or in review:

- an open PR (possibly the user's own) covering the same files
- existing tests already covering the described cases
- another contributor assigned to an adjacent issue touching the same code

If two PRs would add the same file path, **rename one**. Identical paths across
branches guarantee a merge conflict; the PR already in review keeps the plain
name.

## What to do at a stop

1. State plainly what was checked and what was found, with quoted real code.
2. Do not fabricate, do not "reframe until it fits", do not fix it by editing
   unrelated source.
3. Offer the honest alternatives: ask the maintainer to clarify or point at the
   right branch; deliver the smaller thing that is genuinely true; or drop it and
   pick up a real issue.

A comment on the issue asking for clarification costs minutes. A fabricated PR
costs credibility that is slow to rebuild.
