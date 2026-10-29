import { updateSafety } from "../app/update-safety";
/**
 * Импорт и обновление колод.
 *
 * Обновление колоды — самое опасное место всего приложения. Пересобрали файл,
 * поправили перевод в одной карточке — и наивная реализация («удалить всё,
 * записать заново») сотрёт прогресс по тысяче карточек. Поэтому здесь
 * переписывается только содержимое, а таблица прогресса не трогается вовсе:
 * связь идёт по идентификатору карточки, который не зависит ни от примера, ни
 * от перевода.
 */

import { validCard, validDeckMeta, uniqueIds } from "./validation";
import type { DeckCard } from "../srs";
import type { AppDatabase, StoredCard, StoredDeck } from "./db";

/** Метаданные из файла `deck.json`. */
export interface DeckMeta {
  id: string;
  name: string;
  version: string;
  language: string;
  card_type: string;
  built_at: string;
  count: number;
  chunks: string[];
  integrity?: { algorithm: "sha256-canonical-json-v1"; chunks: Record<string, string> };
  source?: Record<string, unknown>;
}

export interface DeckFile {
  meta: DeckMeta;
  cards: DeckCard[];
}

export interface ImportResult {
  deckId: string;
  version: string;
  /** Колода уже была этой версии, ничего не делали. */
  skipped: boolean;
  reason?: "same-version" | "older-version" | "version-conflict";
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /**
   * Прогресс по карточкам, которых в новой версии колоды нет.
   *
   * Он не удаляется: если карточка вернётся в следующей сборке, вернётся и
   * выученное. Ненулевое значение стоит показать — это единственный признак,
   * что колода потеряла материал.
   */
  orphanedProgress: number;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameContent(left: StoredCard, right: DeckCard): boolean {
  return (
    left.text === right.text &&
    left.answer === right.answer &&
    left.translation === right.translation &&
    left.note === right.note &&
    left.hint === right.hint &&
    left.position === right.position &&
    left.type === right.type && left.phrase === right.phrase && left.relation === right.relation &&
    left.headword === right.headword && left.sense === right.sense && left.cefr === right.cefr &&
    left.band === right.band && left.ambiguity === right.ambiguity && sameList(left.flags, right.flags) &&
    sameList(left.answers, right.answers) &&
    sameList(left.accept, right.accept) &&
    sameList(left.also, right.also)
  );
}

export interface ImportOptions {
  /** Импортировать, даже если версия совпадает. */
  force?: boolean;
  /** Понижение версии допускается только при явном запросе вызывающего кода. */
  allowDowngrade?: boolean;
  now?: Date;
}

export async function importDeck(
  db: AppDatabase,
  file: DeckFile,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const release = updateSafety.begin();
  try {
    const { meta, cards } = file;
    const now = options.now ?? new Date();
    if (!validDeckMeta(meta) || !cards.every(validCard) || !uniqueIds(cards, "id") || cards.length !== meta.count) {
      throw new Error("неверный формат колоды");
    }


    const incoming = new Map(cards.map((card) => [card.id, card]));
    const result: ImportResult = {
      deckId: meta.id,
      version: meta.version,
      skipped: false,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      orphanedProgress: 0,
    };

    // Одна транзакция на всё: оборванный импорт не должен оставить колоду
    // наполовину обновлённой.
    await db.transaction("rw", db.decks, db.cards, db.progress, async () => {
      const existingDeck = await db.decks.get(meta.id);
      const older = existingDeck !== undefined && existingDeck.version !== meta.version &&
        Date.parse(existingDeck.builtAt) >= Date.parse(meta.built_at);
      const same = existingDeck?.version === meta.version &&
        await db.cards.where("deckId").equals(meta.id).count() === meta.count;
      if ((older && !options.allowDowngrade) || (same && !options.force)) {
        result.skipped = true;
        result.version = existingDeck!.version;
        result.reason = older ? (Date.parse(existingDeck!.builtAt) === Date.parse(meta.built_at) ? "version-conflict" : "older-version") : "same-version";
        result.unchanged = existingDeck!.count;
        return;
      }
      const stored = await db.cards.where("deckId").equals(meta.id).toArray();
      const existing = new Map(stored.map((card) => [card.id, card]));

      const toWrite: StoredCard[] = [];
      for (const [id, card] of incoming) {
        const previous = existing.get(id);
        if (previous === undefined) {
          result.added += 1;
          toWrite.push({ ...card, deckId: meta.id });
        } else if (sameContent(previous, card)) {
          result.unchanged += 1;
        } else {
          result.updated += 1;
          toWrite.push({ ...card, deckId: meta.id });
        }
      }

      const removedIds = [...existing.keys()].filter((id) => !incoming.has(id));
      result.removed = removedIds.length;

      if (removedIds.length > 0) await db.cards.bulkDelete(removedIds);
      if (toWrite.length > 0) await db.cards.bulkPut(toWrite);

      // Прогресс по исчезнувшим карточкам остаётся лежать: если карточка
      // вернётся, вернётся и выученное по ней.
      if (removedIds.length > 0) {
        const orphaned = await db.progress.where("cardId").anyOf(removedIds).count();
        result.orphanedProgress = orphaned;
      }

      const deck: StoredDeck = {
        id: meta.id,
        name: meta.name,
        version: meta.version,
        language: meta.language,
        cardType: meta.card_type,
        count: cards.length,
        builtAt: meta.built_at,
        importedAt: now.toISOString(),
        ...(meta.source ? { source: meta.source } : {}),
      };
      await db.decks.put(deck);
    });

    return result;
  } finally { release(); }
}

/** Все импортированные колоды. */
export async function listDecks(db: AppDatabase): Promise<StoredDeck[]> {
  return db.decks.orderBy("importedAt").toArray();
}

/** Карточки колоды в порядке изучения. */
export async function loadCards(
  db: AppDatabase,
  deckId: string,
): Promise<StoredCard[]> {
  const cards = await db.cards.where("deckId").equals(deckId).toArray();
  cards.sort((left, right) => left.position - right.position);
  return cards;
}

/**
 * Удаляет колоду вместе с прогрессом и журналом по её карточкам.
 *
 * В отличие от обновления, это осознанное расставание с выученным, поэтому
 * чистится всё — иначе в базе копились бы сироты, которых никогда не увидеть.
 */
export async function removeDeck(db: AppDatabase, deckId: string): Promise<void> {
  const release = updateSafety.begin();
  try {
    await db.transaction(
      "rw",
      [db.decks, db.cards, db.progress, db.reviews, db.changes],
      async () => {
        const ids = [...new Set([
          ...await db.cards.where("deckId").equals(deckId).primaryKeys(),
          ...await db.progress.where("deckId").equals(deckId).primaryKeys(),
          ...await db.changes.where("deckId").equals(deckId).primaryKeys(),
        ])] as string[];
        await db.changes.where("deckId").equals(deckId).delete();
        await db.cards.where("deckId").equals(deckId).delete();
        await db.progress.where("deckId").equals(deckId).delete();
        if (ids.length > 0) {
          await db.reviews.where("cardId").anyOf(ids).delete();
        }
        await db.decks.delete(deckId);
      },
    );
  } finally { release(); }
}
