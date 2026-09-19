/**
 * Кладёт собранные колоды в статику приложения.
 *
 * Колоды лежат в `decks/` в корне репозитория — это выход пайплайна. Vite
 * раздаёт только то, что внутри `app/public`, поэтому перед запуском и сборкой
 * файлы копируются туда.
 *
 * Копия, а не второй экземпляр в репозитории: `app/public/decks` не
 * коммитится. Полторы тысячи килобайт JSON, дублирующих то, что уже есть в
 * соседнем каталоге, только мешали бы читать историю.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "decks");
const target = join(here, "..", "public", "decks");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  console.error(
    `колод нет в ${source}\n` +
      "сначала соберите их: python -m pipeline.deck.build run",
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

// Сообщение по-английски намеренно: сборку запускают из Коллокации.cmd, а
// консоль Windows читает вывод node в CP866 и превращает кириллицу в мусор.
console.log(`decks copied to ${target}`);
