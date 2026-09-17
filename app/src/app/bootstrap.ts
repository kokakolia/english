/**
 * Подготовка приложения к работе: база и колода.
 *
 * Колода раздаётся статикой, но учить приложение будет из базы, а не из файлов:
 * так работа не зависит от сети после первого запуска. Отсюда порядок — при
 * старте пытаемся обновиться, а если сети нет, продолжаем с тем, что уже
 * импортировано.
 *
 * Отсутствие сети при уже импортированной колоде — не ошибка, а обычный режим
 * работы офлайн-приложения, и говорить о нём как об ошибке неправильно.
 */

import {
  getDatabase,
  importDeck,
  listDecks,
  loadDeckFile,
  loadDeckIndex,
  type AppDatabase,
  type ImportResult,
  type StoredDeck,
} from "../storage";

const DECKS_URL = "/decks";

export interface BootstrapResult {
  db: AppDatabase;
  decks: StoredDeck[];
  /** Итог импорта, если он состоялся. */
  imported: ImportResult | null;
  /** Работаем с тем, что уже в базе: свежую колоду достать не удалось. */
  offline: boolean;
  /** Сообщение о том, что пошло не так, если это помешало работе. */
  error: string | null;
}

export async function bootstrap(
  baseUrl: string = DECKS_URL,
): Promise<BootstrapResult> {
  const db = getDatabase();
  await db.open();

  const known = await listDecks(db);

  try {
    const index = await loadDeckIndex(baseUrl, (url) => fetch(url));
    const entry = index[0];
    if (entry === undefined) {
      return {
        db,
        decks: known,
        imported: null,
        offline: false,
        error: known.length > 0 ? null : "в каталоге колод пусто",
      };
    }

    const deckUrl = `${baseUrl}/${entry.id}`;
    const file = await loadDeckFile(deckUrl, (url) => fetch(url));
    const imported = await importDeck(db, file);

    return {
      db,
      decks: await listDecks(db),
      imported,
      offline: false,
      error: null,
    };
  } catch (cause) {
    // Сети нет. Если колода уже импортирована, это штатный офлайн.
    if (known.length > 0) {
      return { db, decks: known, imported: null, offline: true, error: null };
    }
    return {
      db,
      decks: [],
      imported: null,
      offline: true,
      error: `колода недоступна, а в базе её ещё нет: ${String(cause)}`,
    };
  }
}
