---
name: process-inbox
description: Turn informal notes in ai/inbox.md into tracked task files under ai/tasks/. Use when the user invokes /process-inbox, asks to triage the inbox, or wants inbox notes turned into tasks without implementing anything yet.
---

# Process Inbox

Route and plan only. Do not edit application code, run the project's build/lint/tests, or
implement anything in this skill — that's `perform-task`'s job.

## Workspace

Работай в текущей рабочей копии. Если `git status` грязный и изменения не относятся к этой
задаче — остановись и спроси, прежде чем трогать инбокс.

## Read first

- `AGENTS.md` (project overview and the "Known baseline issues" section).
- `ai/inbox.md`.
- Existing `ai/tasks/*/task.md` and `state.yaml`, so a new task doesn't duplicate one
  already tracked.

## Route first

Трекинг гибридный: мелкая работа — task-файлы, крупная — issue (`docs/agents/issue-tracker.md`).
Прежде чем создавать task-файл, реши, куда идёт пункт инбокса:

- **GitHub Issue**, если это крупная фича или баг, либо правка задевает публичный
  API, верхнеуровневое поведение UI, формат данных или затрагивает больше
  ~2 файлов:

  ```bash
  gh issue create --title "..." --body "..." --label "bug"   # bug/enhancement — см. docs/agents/triage-labels.md
  ```

  Такой пункт из `ai/inbox.md` убирается, а номер issue (`(#NN)`) попадает в
  будущий коммит как перекрёстная ссылка. Закрывает issue closing-ключевое
  слово `Closes #NN` отдельной строкой в теле PR — GitHub закрывает issue сам
  при мержаже PR в дефолтную ветку.
- **Task-файл** в `ai/tasks/` — только для небольшой механической работы, которую
  можно выполнить и проверить за одну сессию.

Крупное, но сформулированное в одну строку («почини 9 lint-ошибок») — это Issue,
а не task: у него отдельный reviewed-диф и он не должен ехать в общем потоке с
чужими правками.

## For each inbox item

An item is one bullet, or one short paragraph — an entry ends at the next top-level bullet
or heading. Two sentences about the same idea are one item; two different ideas typed in
the same sitting are two items, even if adjacent.

1. Pick a concise imperative kebab-case slug and use today's date. Task path:
   `ai/tasks/YYYY-MM-DD/<slug>/`. Check existing directories under `ai/tasks/` and append
   `-2`, `-3`, … to resolve a same-day collision.
2. Write `task.md`:

   ```markdown
   # <imperative title>

   <self-contained description, in your own words, of what was asked and why —
   someone with zero chat context should be able to read this and know what to do>

   ## Acceptance

   - <specific, observable result that proves this is done>
   ```

   Only include acceptance criteria that actually prove the requested behavior. Don't
   invent "leave everything else unchanged" or test-data-integrity criteria — this is a
   normal git repo, the history is the record.
3. Write `state.yaml`:

   ```yaml
   status: todo
   created: YYYY-MM-DD
   depends_on: []
   ```

   Add another task's id to `depends_on` only when this task's implementation genuinely
   assumes that task's change has already landed.
4. Split only at real product boundaries: two genuinely independent, independently
   testable outcomes. Don't split one small UI tweak into artificial pieces, and don't
   lump unrelated ideas into one task merely because they were typed in the same inbox
   entry.

## Publish

Remove the entries you turned into tasks from `ai/inbox.md`; leave anything you didn't
process (and say why in your report — e.g. too vague, needs a decision from Andrew first).

```bash
git add ai/inbox.md ai/tasks/<every touched path>
git commit -m "Process inbox: <n> task(s)"
```

Stage and commit exactly those paths — never anything else sitting in the working tree.

## Report

List each new task's id and title, and anything left unprocessed in the inbox with a short
reason.
