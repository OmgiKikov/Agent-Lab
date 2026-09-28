# Workshop

Сервер и интерфейс Agent Lab. Это наш форк [Raindrop Workshop](https://github.com/raindrop-ai/workshop) 0.1.21
(лицензия MIT, см. `LICENSE`): локальный просмотрщик трейсов агентов с разделом **agent lab**.

Что наше поверх Raindrop Workshop:

- раздел Agent Lab: `app/src/pages/LabPage.tsx`, пункт в меню (`app/src/components/NavSidebar.tsx`) и маршруты `/lab`;
- заметки судьи как автор «Судья · Agent Lab» (`app/src/api/annotations.ts`, `AnnotationChip.tsx`);
- кнопка «Спросить Agent Lab» в разговоре (`MessagePane.tsx`);
- всё внутри сборки: шрифты лежат в ней, счётчика Raindrop нет, `update` не подменяет сборку их релизом;
- заметки прошлых прогонов видны сразу (исправление `placeholderData` в аннотациях).

## Сборка

    sh ../bin/build-workshop.sh

Bun собирает сервер (`src/`) и интерфейс (`app/`) в один файл `build/raindrop`. Данные Workshop — трейсы,
разметка, папки — лежат в `~/.raindrop/`. `bin/start.sh` запускает эту сборку сам, а на компьютере без Bun
скачивает готовую из релизов репозитория (`bin/release-workshop.sh` её публикует).

Разработка интерфейса: `bun run dev` — сервер из исходников и Vite на http://localhost:5900.
