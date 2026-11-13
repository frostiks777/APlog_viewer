---
name: perform-task
description: Implement, self-review, test, and commit exactly one existing ai/tasks task, by slug or full date/slug id. Use when the user invokes /perform-task <name>, or the continue scheduler delegates one selected task.
---

# Perform One Task

Own exactly one task through to a committed result or an honestly recorded blocker. Do not
switch to a different task, do not process the inbox, and do not start a second task after
this one finishes — that's `continue`'s job.

## Resolve

Find the task under `ai/tasks/` by slug or full `date/slug` id. If the name matches more
than one task, list the matches and ask which one instead of guessing. Read that task's
`task.md` and `state.yaml`.

- `status: approved` → report the existing result and stop; don't redo it.
- `status: blocked` → read why before retrying. If the blocker is resolved, continue from
  where it left off rather than restarting from scratch.
- `status: todo` or `in-progress` → proceed.

If `depends_on` names a task that isn't `approved` yet, stop and report which one is
missing.

Set `status: in-progress` in `state.yaml` before writing any application code (fold this
into the eventual work commit if that's simpler — just don't leave the queue showing
`todo` while you're actively working on it).

## Implement

Read `AGENTS.md` and `.agents/shared/checks.md` completely before writing code. Make the
smallest change that satisfies every line under `task.md`'s `## Acceptance`. Stay inside
this task's own scope: a genuinely separate improvement you notice along the way goes into
`ai/inbox.md` as a new note for a future task — it does not ride along in this diff.

## Self-review

Read the complete diff yourself before running any checks. Walk it against `task.md`'s
Acceptance criteria one by one. Look for obvious correctness issues and confirm the diff
doesn't touch files the task had no reason to touch.

## Test

Run every check in `.agents/shared/checks.md`. A check that fails only on something listed
under `AGENTS.md`'s "Known baseline issues" doesn't block this task; anything your own
change caused does. If a check fails because of this task's change, fix it and re-run —
never report a task done with a failing check that your diff caused.

Append a `## Result` section to `task.md`:

```markdown
## Result

- Commands run: <exact commands>
- Lint: <pass | pre-existing baseline errors only, listed>
- Build: <pass | dev-mode fallback used, why>
- Smoke tests: <pass | which spec(s) added/extended>
- Screenshot: <path under .agents-runs/<task-id>/, for a UI change — or "n/a">
```

## Publish

```bash
git add <exact files this task touched, plus ai/tasks/<id>/task.md and state.yaml>
git commit -m "<Imperative summary>

Task: <task-id>"
```

Set `status: approved` in `state.yaml` in the same commit — or `status: blocked` with the
exact reason written into `task.md`, leaving the branch otherwise clean and the task
resumable. Never commit a file this task didn't touch, and never commit anything under
`.agents-runs/` (it's gitignored on purpose — scratch evidence, not project history).

## Report

Task id, final status, files touched, checks run and their results, and anything you
noticed but deliberately left out of scope (and confirmation it's now in `ai/inbox.md`).
