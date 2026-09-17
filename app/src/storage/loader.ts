/**
 * Загрузка файлов колоды.
 *
 * Колода разбита на части ради ленивой загрузки, но для импорта нужна целиком:
 * приложение читает её один раз и дальше работает с базой. Поэтому здесь
 * собирается полный `DeckFile`, а не отдаётся поток.
 *
 * `fetch` передаётся аргументом, а не берётся из глобального объекта: так
 * загрузчик проверяется без сети и без браузера.
 */

import type { DeckCard } from "../srs";
import type { DeckFile, DeckMeta } from "./decks";

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface DeckIndexEntry {
  id: string;
  name: string;
  version: string;
  count: number;
  /** Путь к `deck.json` относительно каталога колод. */
  path: string;
}

export class DeckLoadError extends Error {}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new DeckLoadError(`не удалось загрузить ${url}: ${String(cause)}`);
  }
  if (!response.ok) {
    throw new DeckLoadError(`не удалось загрузить ${url}: код ${response.status}`);
  }
  return response.json();
}

function join(base: string, path: string): string {
  return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** Перечень доступных колод из `index.json`. */
export async function loadDeckIndex(
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<DeckIndexEntry[]> {
  const data = (await fetchJson(fetchImpl, join(baseUrl, "index.json"))) as {
    decks?: DeckIndexEntry[];
  };
  if (!Array.isArray(data.decks)) {
    throw new DeckLoadError("в index.json нет списка колод");
  }
  return data.decks;
}

/** Колода целиком: метаданные и все карточки из частей. */
export async function loadDeckFile(
  deckUrl: string,
  fetchImpl: FetchLike,
): Promise<DeckFile> {
  const meta = (await fetchJson(fetchImpl, join(deckUrl, "deck.json"))) as DeckMeta;
  if (!Array.isArray(meta.chunks)) {
    throw new DeckLoadError("в deck.json нет списка частей");
  }

  const parts = await Promise.all(
    meta.chunks.map((chunk) => fetchJson(fetchImpl, join(deckUrl, chunk))),
  );

  const cards: DeckCard[] = [];
  for (const part of parts) {
    if (!Array.isArray(part)) {
      throw new DeckLoadError("часть колоды не является списком карточек");
    }
    cards.push(...(part as DeckCard[]));
  }

  // Несовпадение обещанного и полученного означает битую или недокачанную
  // колоду — лучше отказаться, чем импортировать половину.
  if (typeof meta.count === "number" && cards.length !== meta.count) {
    throw new DeckLoadError(
      `в колоде обещано ${meta.count} карточек, получено ${cards.length}`,
    );
  }

  return { meta, cards };
}
