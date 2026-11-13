---
name: commit-push
description: Use when the user asks to commit and push changes — «сделай коммит и пуш», «коммит + пуш», «закоммить», «запушь», «залей изменения», «commit», «push». Runs project checks, stages only intended files, writes a Conventional Commits message, commits and pushes.
---

# Commit & Push

Workflow для коммита и пуша (Conventional Commits).

## 1. Проверки перед коммитом

```bash
git status --short
git diff
git log --oneline -10
```

Затем прогнать чек-чейн из `.agents/shared/checks.md` и починить проблемы до коммита.
Конкретные команды живут там, а не в этом скилле.

Пропускать проверки можно только по явной просьбе пользователя.

## 2. Стейджинг

- Стейджить только конкретные файлы: `git add <paths>`; `git add -A` — только если все изменения относятся к одной задаче.
- Никогда не коммитить: секреты, `.env*` (кроме `.env.example`), зависимости и артефакты сборки, локальный state — всё, что перечислено в `.gitignore` проекта.
- Сгенерированные файлы (кэши, типы, отчёты) не коммитить, если они не часть изменения.
- Если изменений несколько логических — делать отдельные коммиты, по одному на изменение.

## 3. Сообщение коммита

Conventional Commits, тип на английском, описание краткое и в повелительном наклонении:

- `feat(ui): add cover editing for the selected item`
- `fix(api): handle a 404 from the upstream service`
- `chore(skills): add verify skill`
- `docs:`, `refactor:`, `test:` — по смыслу

Задача, пришедшая из GitHub Issue (гибридный трекинг, см. `AGENTS.md`), указывает номер в сообщении: `fix: ... (#42)` — это перекрёстная ссылка, она ничего не закрывает. Закрывает issue closing-ключевое слово `Closes #42` отдельной строкой в теле PR: GitHub закрывает issue сам при мержаже PR в дефолтную ветку. Без PR (task-флоу, `ai/tasks`) закрытие ручное: `gh issue close <n> --comment "<хеш>"`.

## 4. Коммит и пуш

```bash
git commit -m "<type>: <описание>"
git push
```

- Не амендить, не пропускать хуки, не делать force-push без явной просьбы.
- Если у ветки нет upstream: `git push -u origin <branch>`.

## 5. Отчёт

Сообщить: хеш и текст каждого коммита, ветку, результат пуша. Если пуш не удался — показать ошибку и не повторять force-варианты.

## Важное для этого репозитория

- `git push` в `main` запускает CI (`ci.yml`: lint+build) и деплой (`deploy.yml` — сборка на раннере + rsync на VPS). Пуш = релиз, не делай его вслепую.
- Историю ведём по Conventional Commits — от этого зависит release-please.
- `git add -A` в этом репо особенно опасен: `telegram-bot/` держит состояние с чужими приватными данными (см. `AGENTS.md`).
