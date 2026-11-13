# Third-Party Notices

Этот репозиторий содержит скиллы и документы из сторонних источников. Ниже перечислены
источники, лицензии и условия перераспространения. Все внешние источники используют
permissive-лицензии (MIT, Apache-2.0 или CC BY 4.0); скиллов, исключённых из-за лицензии,
нет.

Публикуемый набор — **84 скилла**. Два проектных скилла, `apply-design` и `apply-design-v2`,
в него не входят по решению Task 6: они привязаны к конкретному проекту-донору, а не к
лицензионным ограничениям.

## Скиллы из mattpocock/skills

- Источник: https://github.com/mattpocock/skills
- Лицензия: MIT, Copyright (c) 2026 Matt Pocock
- Состав: 38 скиллов; точные пути и хеши — в `skills-lock.json`.
- Скиллы: `ask-matt`, `claude-handoff`, `code-review`, `codebase-design`,
  `diagnosing-bugs`, `domain-modeling`, `git-guardrails-claude-code`, `grill-me`,
  `grill-with-docs`, `grilling`, `handoff`, `implement`, `implement-spec`,
  `improve-codebase-architecture`, `loop-me`, `migrate-to-shoehorn`, `pr`, `prototype`,
  `research`, `resolving-merge-conflicts`, `retro`, `scaffold-exercises`,
  `setup-matt-pocock-skills`, `setup-pre-commit`, `setup-ts-deep-modules`, `tdd`, `teach`,
  `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wayfinder`, `wizard`,
  `writing-beats`, `writing-for-agents`, `writing-fragments`, `writing-shape`.

Скилл `pr` из этого набора содержит кредит HumanLayer/Dex Horthy (skill `show-me`);
подробности — в разделе «pr».

## gh-address-comments

- Источник: https://github.com/openai/skills (путь `skills/.curated/gh-address-comments`)
- Лицензия: Apache License 2.0.
- Файл лицензии сохраняется рядом со скиллом при копировании:
  `.agents/skills/gh-address-comments/LICENSE.txt`.
- Полный текст: https://github.com/openai/skills/blob/main/skills/.curated/gh-address-comments/LICENSE.txt

## browser-skill

- Источник: https://github.com/Tencent/BrowserSkill
- Лицензия: MIT, Copyright (c) 2026 Tencent
- Скиллы: `browser-skill`.
- Локальная копия адаптирована для этого харнесса (вариант DeepSeek Harness).

## open-code-review

- Источник: https://github.com/alibaba/open-code-review
- Лицензия: Apache License 2.0.
- Скиллы: `open-code-review`.
- Полный текст: https://github.com/alibaba/open-code-review/blob/main/LICENSE

## pr

- Источник: https://github.com/humanlayer/skills (skill `show-me`)
- Лицензия: MIT, Copyright (c) 2026 HumanLayer
- Скиллы: `pr` (распространяется в составе `mattpocock/skills`, MIT).
- Кредит автора сохранён во frontmatter скилла.

## i-have-adhd

- Источник: https://github.com/ayghri/i-have-adhd
- Лицензия: MIT, Copyright (c) 2026 Ayoub Ghriss
- Скиллы: `i-have-adhd`.

## security-audit

- Источник: https://github.com/cloudflare/security-audit-skill
- Лицензия: MIT, Copyright (c) 2025-2026 Cloudflare, Inc.
- Скиллы: `security-audit`.

## archify-review

- Источник: https://github.com/tt-a1i/archify
- Лицензия: Apache License 2.0.
- NOTICE: Copyright (c) 2026 tt-a1i (Archify), Copyright (c) 2025 Cocoon AI.
- Скиллы: `archify-review`.
- Полный текст: https://github.com/tt-a1i/archify/blob/main/LICENSE

## Скиллы из tech-leads-club/agent-skills

- Источник: https://github.com/tech-leads-club/agent-skills
- Лицензия репозитория: MIT, Copyright (c) 2026 Tech Leads Club.
- Часть файлов декларирует CC BY 4.0 — permissive-лицензию с обязательной атрибуцией.
- Состав: 31 скилл.

Атрибуция по авторам:

- **Felipe Rodrigues** (https://github.com/felipfr), CC BY 4.0:
  `codenavi`, `evolutionary-modular-architecture`, `frontend-blueprint`,
  `legacy-migration-planner`, `nestjs-modular-monolith`, `not-your-babysitter`,
  `react-native-expert`, `tlc-spec-driven`.
- **Waldemar Neto** (https://github.com/waldemarnt), CC BY 4.0:
  `confluence-assistant`, `spec-driven-eval`.
- **William Calderipe** (https://github.com/wcalderipe), MIT: `rails-dev`.
- **Vercel**, MIT: `react-composition-patterns`.
- **Tech Leads Club**, CC BY 4.0: `harness-eval`, `tlc-discover`, `tlc-implement`,
  `tlc-plan`, `tlc-spec-lean`.
- **Karpathy Guidelines** (https://github.com/multica-ai/andrej-karpathy-skills), MIT:
  `coding-guidelines`.
- **Без отдельной атрибуции в SKILL.md**, MIT (лицензия репозитория):
  `component-common-domain-detection`, `component-flattening-analysis`,
  `component-identification-sizing`, `coupling-analysis`, `decomposition-planning-roadmap`,
  `docs-writer`, `domain-analysis`, `domain-identification-grouping`, `jira-assistant`,
  `modular-decomposition`, `modular-design-principles`, `shopify-developer`, `tactical-ddd`.

Часть файлов адаптирована под этот харнесс; исходная атрибуция сохранена в `SKILL.md`
каждого скилла.

## Прочие скиллы

Скиллы без внешней атрибуции — авторские, импортированы из собственного проекта-донора
`frostiks777/ai-for-developers-project-386` (commit `c84967c`) и адаптированы под этот
харнесс. Они распространяются на условиях MIT этого репозитория.

Состав (11): `apply-design`, `apply-design-v2`, `commit-push`, `continue`, `interview`,
`perform-task`, `plan`, `ponytail`, `process-inbox`, `telegram-bridge`, `verify`.

`apply-design` и `apply-design-v2` — проектные и в публикуемый набор не входят.

## Исключения по лицензии

Нет. Для всех внешних источников найдена permissive-лицензия (MIT, Apache-2.0 или
CC BY 4.0), разрешающая перераспространение с сохранением атрибуции.

## Тексты лицензий

- MIT: https://opensource.org/license/mit ; полный текст также в `LICENSE` этого
  репозитория.
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0 ; копия для
  `gh-address-comments` лежит в `.agents/skills/gh-address-comments/LICENSE.txt`.
- CC BY 4.0: https://creativecommons.org/licenses/by/4.0/legalcode
