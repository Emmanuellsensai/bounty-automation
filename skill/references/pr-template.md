# PR description template

The goal is to answer every question a careful reviewer would raise, before they
raise it. Adapt the sections; drop the ones that do not apply.

```markdown
Closes #N          <!-- or: Partially addresses #N -->

## Summary
One or two sentences: what this does and why.

## Approach
How it fits the existing code. Name the real patterns reused and the real types
or modules involved. If the issue's framing did not match the codebase, say so
here plainly and state what was implemented instead.

## Changes
- `path/to/file`: what changed and why
- `path/to/file`: what changed and why

## Acceptance criteria
Map each criterion from the issue to how it is met. If one is not met, say so
and why.

## Verification
- typecheck / lint / tests / formatter / build: actual results
- new tests: count and what they cover

## Notes for reviewers
Anything that would otherwise look odd in the diff:
- verification scoped narrowly, and why
- pre-existing failures unrelated to this change, with the numbers proving it
  (base branch vs this branch)
- deviations from a pure implementation of the issue, disclosed
- deliberate omissions and why they are out of scope
- judgement calls the maintainer may want to overrule
```

## Rules

**Never claim a verification that was not run.** If the full build could not run
because the repo is pre-broken elsewhere, say the verification was scoped and
name what was excluded. Overstating is what gets a PR picked apart.

**Disclose deviations.** Removing dead code to make a build pass, renaming a file
to avoid a collision, leaving a lockfile out - each gets a line. Surprises in a
diff cost more trust than the deviation itself.

**Turn findings into value.** If the work surfaced a real bug (an unmounted
route, a stale comment claiming a security control that is not enforced), give it
its own heading rather than burying it. It is often worth more to the maintainer
than the change itself, and may warrant its own issue.

**Do not fix unrelated repo debt inside a scoped PR.** Note it, offer to handle
it separately.

**Prove pre-existing breakage with numbers.** "CI is red for everyone" is
unconvincing; "base branch: 33 failed suites / 71 failed tests; this branch: 33
failed / 72, where the +3 are this PR's passing tests" is not. Include the
command so the reviewer can reproduce it.
