---
name: telegram-bridge
description: Use when notifying the user via the personal Telegram bridge or awaiting their approval from the phone — «напиши в телеграм», «согласуй», «жди решения», «проверь ответ». Sends via telegram-bot/notify.mjs, reads decisions.jsonl/inbox.jsonl. Triggers on telegram-bridge, Telegram-мост, согласование с телефона.
---

# Telegram-bridge

Персональный мост в Telegram для согласований, когда пользователь не у компа. Код — в `telegram-bot/`: **скрипты и README трекаются в git**, состояние (`.env`, `inbox.jsonl`, `outbox.jsonl`, `decisions.jsonl`, `.bot.pid`, `.bot.lock`) — в `.gitignore`. Ноль зависимостей.

## Когда применять

- Агент упёрся в вопрос/выбор/блокер и ждёт решения (тот же случай, что и Windows-тост в `AGENTS.md`).
- Успешный релиз: push сделан, CI/деплой взлетел.
- Пользователь явно просит «напиши в Telegram» / «согласуй с телефона».

## Как отправить

```bash
node telegram-bot/notify.mjs "Заголовок" "Текст"
node telegram-bot/notify.mjs "Нужно решение" "Делаем X?" --id q123  # с кнопками ✅/⛔
```

- Без заполненного `telegram-bot/.env` отправка молча пропускается (exit 0) — это норма, не ошибка.
- Текст — короткий, по-русски, без секретов (токены, пароли, содержимое `.env` — никогда).

## Как дождаться решения

1. Отправь вопрос с `--id <qid>` (уникальный id, напр. `q123`).
2. Пользователь жмёт ✅/⛔ либо пишет `/approve <qid>` / `/deny <qid>` (бот `node telegram-bot/bot.mjs` должен быть запущен у пользователя).
3. Прочитай `telegram-bot/decisions.jsonl`, возьми **последнюю** строку с этим `qid`: `{"at": ..., "by": ..., "qid": ..., "decision": "approve"|"deny"}`.
4. Нет строки с `qid` — решения нет, не выдумывай: переспроси в чате или жди. Сырой лог — `telegram-bot/inbox.jsonl`.

## Свободные вопросы пользователя (не команды)

Обычный текст (не `/команда`) бот кладёт в `telegram-bot/inbox.jsonl`. Агент сам не просыпается — забери вопросы при следующем контакте:

```bash
node telegram-bot/unread.mjs   # вопросы без ответов (после последней реплики)
node telegram-bot/reply.mjs "Текст ответа"  # ответ уходит в Telegram + пишется в outbox.jsonl
```

Порядок: `unread.mjs` → ответь в чате → продублируй ответ через `reply.mjs`. Проверяй `unread.mjs` каждый раз, когда пользователь выходит на связь после перерыва.

## Автозапуск и автоуведомления

`node telegram-bot/bot.mjs` и уведомления «я закончил / я упал» поднимаются сами плагином `.opencode/plugins/telegram-autostart.js` при старте opencode (GUI и CLI) — пользователю ничего запускать не надо. Плагин защищён lock-каталогом `.bot.lock` и pid-файлом: несколько параллельных сессий opencode не поднимут второй poller на том же токене (Telegram ответил бы 409). Уведомления молчат, если в `telegram-bot/.env` не стоит `TELEGRAM_NOTIFY=on` (по умолчанию `off`); антиспам — не чаще раза в минуту на тип события. Остановить — `taskkill /PID <число из telegram-bot/.bot.pid> /F`. Если `telegram-bot/` или `.env` удалены, бот не поднимается, а `notify.mjs`/`reply.mjs` молча пропускают отправку.

## Команды пользователя с телефона

- `/ping` — жив ли бот; `/status` — ветка, последний коммит, грязные файлы.
- `/approve <id>` / `/deny <id>` — решение по вопросу.
- Бот отвечает только `TELEGRAM_ALLOWED_CHAT_ID`, чужие чаты игнорит.

## Запрещено

- Спамить на каждый шаг — только блокер/решение и успешный релиз (как с тостом).
- Коммитить состояние `telegram-bot/` (`.env`, `*.jsonl`, `.bot.pid`, `.bot.lock`) — оно в `.gitignore`; скрипты трекаются.
- Писать секреты в сообщения; светить токен бота в чате/логах.
- Выдумывать решение пользователя при отсутствии записи в `decisions.jsonl`.
