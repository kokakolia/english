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
  type FetchLike,
} from "../storage";

const DECKS_URL = "/decks";
export const STARTUP_NETWORK_TIMEOUT_MS = 3000;

export interface BootstrapOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Общий срок для каталога, манифестов и тел ответов, даже если fetch игнорирует abort. */
function networkScope(options: BootstrapOptions) {
  const controller = new AbortController();
  let reject: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, fail) => {
    reject = fail;
  });
  void cancelled.catch(() => {});
  const stop = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    reject(reason);
  };
  const abort = () =>
    stop(options.signal?.reason ?? new Error("Загрузка отменена."));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => stop(new Error("Истекло время ожидания обновления колод.")),
    options.timeoutMs ?? STARTUP_NETWORK_TIMEOUT_MS,
  );
  const within = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, cancelled]);
  const fetcher: FetchLike = async (url) => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await within(fetch(url, { signal: controller.signal }));
    return {
      ok: response.ok,
      status: response.status,
      json: () => within(response.json()),
    };
  };
  return {
    fetcher,
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      stop(new Error("Загрузка завершена."));
    },
  };
}

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
  options: BootstrapOptions = {},
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

  const network = networkScope(options);
  let imported: ImportResult | null = null;
  let offline = false;
  let error =
    "В копии есть данные колоды, но нет полного набора карточек. Восстановите полную резервную копию.";
  try {
    const index = await loadDeckIndex(baseUrl, network.fetcher);
    if (index.length === 0)
      error =
        "В каталоге нет колод, а в локальной базе нет полного набора карточек. Восстановите полную резервную копию.";
    const outcomes = await Promise.allSettled(
      index.map(async (entry) => {
        const file = await loadDeckFile(
          `${baseUrl}/${entry.id}`,
          network.fetcher,
        );
        if (file.meta.id !== entry.id)
          throw new Error("Идентификатор колоды не совпадает с каталогом.");
        return importDeck(db, file);
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") imported ??= outcome.value;
      else {
        offline = true;
        error = `колода недоступна: ${String(outcome.reason)}`;
      }
    }
  } catch (cause) {
    offline = true;
    error = `колода недоступна, а в базе её ещё нет: ${String(cause)}`;
  } finally {
    network.dispose();
  }
  const decks = await listUsableDecks(db);
  return {
    db,
    decks,
    imported,
    offline,
    error: decks.length > 0 ? null : error,
  };
}
