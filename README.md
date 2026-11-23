# SquadHabit

## Запуск за 3 шага

1. Создайте `.env` командой `Copy-Item .env.example .env` и проверьте настройки. Для локального запуска оставьте `DEV_MODE=true`; для настоящего бота укажите `BOT_TOKEN` и `BOT_USERNAME`.
2. Запустите HTTPS-туннель к `http://localhost:8080` (например, `cloudflared tunnel --url http://localhost:8080`) и укажите полученный HTTPS URL в `WEBAPP_URL`, если будете открывать Mini App в Telegram.
3. Выполните `docker compose up -d --build`, затем откройте <http://localhost:8080>. Логи: `docker compose logs -f backend`.

## Настройка Telegram

Создайте бота через [@BotFather](https://t.me/BotFather). Чтобы включить inline-вызовы, выполните `/setinline` и задайте текст-подсказку. Создайте Mini App командой `/newapp` либо настройте кнопку меню через `/setmenubutton`; укажите HTTPS URL туннеля из шага 2. Для обычной разработки в браузере приложение доступно по `http://localhost:8080`.

Перед публикацией задайте `DEV_MODE=false`, HTTPS `WEBAPP_URL`, `BOT_TOKEN` и `BOT_USERNAME` в `.env`.

## Обновление базы данных

Контейнер backend применяет актуальную Prisma-схему командой `prisma db push` при каждом старте. После выкладки изменений пересоберите и перезапустите backend:

```powershell
docker compose up -d --build backend
```

Для ручного применения схемы используйте `npx prisma db push` из каталога `backend` с настроенным `DATABASE_URL`. Отдельные migration-файлы не используются текущим Docker-деплоем.
