---
name: continue
description: Work through the ai/tasks queue for this repo - resume anything in-progress, else start the next todo task, else process the inbox if it has notes. Use when the user invokes /continue or asks to keep working through the task queue.
---

# Continue

Scheduler for this repo's single-checkout task queue. No worktrees, no other checkouts to
coordinate with — just this working copy.

## Before starting

`git status` must be clean, or dirty only with this checkout's own task-scoped
in-progress work (i.e. exactly what `perform-task` would leave behind mid-task). Anything
else: stop and ask before touching the queue.

## Pick one task

1. Any `ai/tasks/*/state.yaml` with `status: in-progress` → resume it.
2. Else the oldest `ai/tasks/*/state.yaml` with `status: todo` whose every `depends_on`
   entry is `approved` → start it.
3. Else, if `ai/inbox.md` has unprocessed content → run
   `.agents/skills/process-inbox/SKILL.md` once, then go back to step 2.
4. Else stop: nothing to do, report that and end the loop.

## Run it

Use `.agents/skills/perform-task/SKILL.md` completely for the task selected above. Don't
reimplement any part of it here.

## Loop

After a task reaches `status: approved`, go back to "Pick one task" and keep going. Stop
the loop (report and wait for a human) when:

- `perform-task` reports the task `blocked`;
- the same check keeps failing after one honest fix attempt inside that task;
- the pre-loop clean-tree requirement above isn't met; or
- there's nothing left to do (step 4).

Never silently skip a blocked or failing task and move to the next one without reporting
it first.

## Report

Every task completed this run (id + one-line summary each), anything left blocked with
why, anything still queued and untouched, and why the loop stopped.
