# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..." --label "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels --jq '[.[] | {number, title, labels: [.labels[].name]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` infers the repo from the git remote, so it works from inside the clone without extra flags.

## Как это связано с `ai/tasks`

Гибридный трекинг. Небольшая механическая работа живёт в `ai/inbox.md` → `ai/tasks/<date>/<slug>/`; крупные фичи, баги и всё, что трогает публичный API, верхнеуровневое поведение UI или формат данных проекта, — здесь, в Issues. Маршрутизацию делает `process-inbox` до создания task-файла.

Issue, который тянет в работу, попадает в коммит как `(#NN)` — это перекрёстная ссылка, она ничего не закрывает. Дальше два потока:

**PR-flow (крупная работа → GitHub Issue → ветка → PR).** Closing-ключевое слово кладётся отдельной строкой в **тело PR**:

```
Closes #42
```

GitHub закрывает issue сам при мержаже PR в дефолтную ветку, и PR показывается в issue как связанный (вкладка Development). Ключевое слово работает только если PR нацелен на дефолтную ветку, и обрабатывается в момент мержа — дописать его в уже смерженный PR поздно. Допустимы `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`; номер должен идти сразу за словом.

**Task-flow (мелкая работа → `ai/tasks`, без PR).** Закрытие ручное:

```bash
gh issue close <number> --comment "Сделано в <commit-sha>"
```

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

Правило: если push в основную ветку деплоит, пушить можно только с зелёным локальным verify (`.agents/shared/checks.md`).

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue (см. `docs/agents/triage-labels.md` про метки).

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.
