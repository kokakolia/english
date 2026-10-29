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
  listUsableDecks,
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
  try {
    await db.open();
  } catch (cause) {
    return {
      db,
      decks: [],
      imported: null,
      offline: false,
      error: `Не удалось открыть локальное хранилище. Проверьте, разрешено ли браузеру хранить данные сайта, и повторите попытку. ${String(cause)}`,
    };
  }

  try {
    const index = await loadDeckIndex(baseUrl, (url) => fetch(url));
    const entry = index[0];
    if (entry === undefined) {
      const cached = await listUsableDecks(db);
      return {
        db,
        decks: cached,
        imported: null,
        offline: false,
        error:
          cached.length > 0
            ? null
            : "В каталоге нет колод, а в локальной базе нет полного набора карточек. Восстановите полную резервную копию.",
      };
    }

    const deckUrl = `${baseUrl}/${entry.id}`;
    const file = await loadDeckFile(deckUrl, (url) => fetch(url));
    const imported = await importDeck(db, file);
    const decks = await listUsableDecks(db);

    return {
      db,
      decks,
      imported,
      offline: false,
      error:
        decks.length > 0
          ? null
          : "В копии есть данные колоды, но нет подходящей версии карточек. Обновите приложение или восстановите полную резервную копию.",
    };
  } catch (cause) {
    // Сети нет. Если колода уже импортирована, это штатный офлайн.
    const cached = await listUsableDecks(db);
    if (cached.length > 0) {
      return { db, decks: cached, imported: null, offline: true, error: null };
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
