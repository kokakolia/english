/**
 * Резервная копия всей базы одним файлом.
 *
 * Синхронизации нет, сервера нет — значит это **единственный** способ не
 * потерять выученное при смене устройства, чистке данных сайта или переустановке
 * браузера. Отсюда требования к формату: он должен быть самодостаточным,
 * читаемым человеком и переживать обновления приложения.
 *
 * Поэтому в копию по умолчанию входят и карточки. Без них восстановление
 * зависело бы от того, доступен ли в этот момент тот самый файл колоды той же
 * версии, — а это ровно та внешняя зависимость, от которой копия должна
 * избавлять.
 */

import { updateSafety } from "../app/update-safety";
import type {
  AppDatabase,
  StoredCard,
  StoredDeck,
  StoredProgress,
  StoredReview,
} from "./db";
import type { SettingRow, ProgressChange } from "./db";
import { withReviewIds } from "./review-id";
import { assertAvailableOwners, assertOwners } from "./ownership";
import {
  object,
  text,
  date,
  validCard,
  validProgress,
  validReview,
  validStoredDeck,
  validStudySettings,
  uniqueIds,
} from "./validation";

export const BACKUP_FORMAT = "collocation-srs-backup";
export const BACKUP_FORMAT_VERSION = 3;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  decks: StoredDeck[];
  cards: StoredCard[];
  progress: StoredProgress[];
  reviews: StoredReview[];
  settings: SettingRow[];
  changes?: ProgressChange[];
}

function backupClaims(data: BackupFile) {
  const rows = [
    ...data.cards.map((row) => ({ cardId: row.id, deckId: row.deckId })),
    ...data.progress,
    ...(data.changes ?? []),
  ];
  // В старой облегчённой копии после сброса может остаться только журнал.
  // При единственной колоде его владелец всё равно известен.
  if (data.decks.length === 1)
    rows.push(
      ...data.reviews.map((row) => ({
        cardId: row.cardId,
        deckId: data.decks[0]!.id,
      })),
    );
  return rows;
}

export interface ExportOptions {
  /**
   * Класть ли в копию содержимое карточек. Без них файл на порядок меньше, но
   * восстановление потребует заново импортировать ту же колоду.
   */
  includeCards?: boolean;
  now?: Date;
}

export async function exportBackup(
  db: AppDatabase,
  options: ExportOptions = {},
): Promise<BackupFile> {
  const release = updateSafety.begin();
  try {
    const includeCards = options.includeCards ?? true;
    // Единый снимок: оценка из другой вкладки не разрывает прогресс и журнал.
    const [decks, cards, progress, reviews, settings, changes] =
      await db.transaction(
        "r",
        [db.decks, db.cards, db.progress, db.reviews, db.settings, db.changes],
        async () =>
          Promise.all([
            db.decks.toArray(),
            includeCards ? db.cards.toArray() : Promise.resolve([]),
            db.progress.toArray(),
            db.reviews.toArray(),
            db.settings.toArray(),
            db.changes.toArray(),
          ]),
      );

    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? new Date()).toISOString(),
      decks,
      cards,
      progress,
      reviews: withReviewIds(reviews),
      settings: settings.filter((row) => row.key !== "backupFolder"),
      changes,
    };
  } finally {
    release();
  }
}

export class BackupFormatError extends Error {}

function assertBackup(data: unknown): asserts data is BackupFile {
  if (typeof data !== "object" || data === null) {
    throw new BackupFormatError("файл копии пуст или не является объектом");
  }
  const file = data as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT) {
    throw new BackupFormatError("это не копия этого приложения");
  }
  if (!Number.isInteger(file.formatVersion) || (file.formatVersion ?? 0) < 1) {
    throw new BackupFormatError("в копии не указана версия формата");
  }
  if (file.formatVersion! > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `копия сделана более новой версией приложения (формат ${file.formatVersion})`,
    );
  }
  for (const key of [
    "decks",
    "cards",
    "progress",
    "reviews",
    "settings",
  ] as const) {
    if (!Array.isArray(file[key])) {
      throw new BackupFormatError(`в копии нет раздела «${key}»`);
    }
  }
  if (!date(file.createdAt)) throw new BackupFormatError("неверная дата копии");
  const checks: [
    string,
    unknown[],
    (value: unknown) => boolean,
    string | null,
  ][] = [
    ["decks", file.decks!, validStoredDeck, "id"],
    [
      "cards",
      file.cards!,
      (value) => validCard(value) && object(value) && text(value.deckId),
      "id",
    ],
    ["progress", file.progress!, validProgress, "cardId"],
    ["reviews", file.reviews!, validReview, null],
    [
      "settings",
      file.settings!,
      (value) =>
        object(value) &&
        text(value.key) &&
        (value.key !== "study" || validStudySettings(value.value)),
      "key",
    ],
  ];
  if (file.formatVersion! >= 2 || file.changes !== undefined) {
    if (!Array.isArray(file.changes))
      throw new BackupFormatError("нет истории изменений прогресса");
    checks.push([
      "changes",
      file.changes,
      (value) =>
        object(value) &&
        text(value.cardId) &&
        text(value.deckId) &&
        date(value.changedAt),
      "cardId",
    ]);
  }
  for (const [name, rows, check, key] of checks) {
    if (!rows.every(check) || (key !== null && !uniqueIds(rows, key))) {
      throw new BackupFormatError(`повреждён раздел «${name}»`);
    }
  }
  const deckIds = new Set(file.decks!.map((deck) => deck.id));
  const identified = file.reviews!.filter((row) => row.eventId !== undefined);
  if (
    !uniqueIds(identified, "eventId") ||
    (file.formatVersion === 3 && identified.length !== file.reviews!.length)
  ) {
    throw new BackupFormatError("неверные идентификаторы событий журнала");
  }
  if (
    [...file.cards!, ...file.progress!, ...(file.changes ?? [])].some(
      (row) => !deckIds.has(row.deckId),
    )
  ) {
    throw new BackupFormatError("запись ссылается на неизвестную колоду");
  }
  for (const deck of file.decks!) {
    const count = file.cards!.filter((card) => card.deckId === deck.id).length;
    if (count !== 0 && count !== deck.count)
      throw new BackupFormatError("в копии неполная колода");
  }
  try {
    assertOwners(backupClaims(file as BackupFile));
  } catch (cause) {
    throw new BackupFormatError(String(cause));
  }
}

export type RestoreMode = "replace" | "merge";

export interface RestoreResult {
  mode: RestoreMode;
  decks: number;
  /** Число реально записанных карточек; пропущенная старая колода сюда не входит. */
  cards: number;
  progress: number;
  reviews: number;
  settings: number;
  /** Записей журнала, уже бывших в базе и потому пропущенных. */
  duplicateReviews: number;
}

export interface RestoreOptions {
  /**
   * `replace` стирает текущую базу и кладёт содержимое копии.
   * `merge` дополняет: по каждой карточке берётся более свежий прогресс, а
   * журнал дополняется недостающими записями.
   */
  mode?: RestoreMode;
}

export async function restoreBackup(
  db: AppDatabase,
  data: unknown,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const release = updateSafety.begin();
  try {
    assertBackup(data);
    const incomingReviews = withReviewIds(data.reviews);
    const mode = options.mode ?? "replace";
    const result: RestoreResult = {
      mode,
      decks: data.decks.length,
      cards: 0,
      progress: data.progress.length,
      reviews: data.reviews.length,
      settings: data.settings.length,
      duplicateReviews: 0,
    };

    await db.transaction(
      "rw",
      [db.decks, db.cards, db.progress, db.reviews, db.settings, db.changes],
      async () => {
        if (mode === "merge")
          await assertAvailableOwners(db, backupClaims(data));
        if (mode === "replace") {
          await Promise.all([
            db.decks.clear(),
            db.cards.clear(),
            db.progress.clear(),
            db.reviews.clear(),
            db.settings.clear(),
            db.changes.clear(),
          ]);
        }

        // От понижения защищён только реально установленный полный набор.
        // Метаданные облегчённой копии не препятствуют восстановлению карточек.
        for (const deck of data.decks) {
          const existing = await db.decks.get(deck.id);
          const cards = data.cards.filter((card) => card.deckId === deck.id);
          const complete = cards.length === deck.count;
          const installed =
            existing !== undefined &&
            (await db.cards.where("deckId").equals(deck.id).count()) ===
              existing.count;
          if (
            !existing ||
            (complete &&
              (!installed ||
                Date.parse(deck.builtAt) > Date.parse(existing.builtAt)))
          ) {
            await db.decks.put(deck);
            if (complete) {
              await db.cards.where("deckId").equals(deck.id).delete();
              await db.cards.bulkPut(cards);
              result.cards += cards.length;
            }
          } else if (
            existing.version === deck.version &&
            complete &&
            (await db.cards.where("deckId").equals(deck.id).count()) !==
              deck.count
          ) {
            await db.cards.where("deckId").equals(deck.id).delete();
            await db.cards.bulkPut(cards);
            result.cards += cards.length;
          }
        }
        await db.settings.bulkPut(
          data.settings.filter((row) => row.key !== "backupFolder"),
        );

        if (mode === "replace") {
          await db.progress.bulkPut(data.progress);
          await db.changes.bulkPut(data.changes ?? []);
          await db.reviews.bulkAdd(
            incomingReviews.map(({ id: _id, ...entry }) => entry),
          );
          return;
        }

        const incomingProgress = new Map(
          data.progress.map((row) => [row.cardId, row]),
        );
        const incomingChanges = new Map(
          (data.changes ?? []).map((row) => [row.cardId, row]),
        );
        const ids = new Set([
          ...incomingProgress.keys(),
          ...incomingChanges.keys(),
        ]);
        for (const cardId of ids) {
          const incoming = incomingProgress.get(cardId);
          const change = incomingChanges.get(cardId);
          const existing = await db.progress.get(cardId);
          const localChange = await db.changes.get(cardId);
          // В старых копиях времени действий нет: lastReview — только запасной
          // вариант, а известная локальная отмена/сброс всегда защищены change.
          const localTime =
            Date.parse(localChange?.changedAt ?? existing?.lastReview ?? "") ||
            0;
          const incomingTime =
            Date.parse(change?.changedAt ?? incoming?.lastReview ?? "") || 0;
          const hasLocal = existing !== undefined || localChange !== undefined;
          if (hasLocal && localTime >= incomingTime) continue;
          if (incoming) await db.progress.put(incoming);
          else await db.progress.delete(cardId);
          if (change) await db.changes.put(change);
          else await db.changes.delete(cardId);
        }

        // UUID события не зависит от часов и локального auto-increment ID.
        for (const entry of incomingReviews) {
          const existing = await db.reviews
            .where("eventId")
            .equals(entry.eventId)
            .first();
          if (existing !== undefined) {
            if (entry.undone && existing.id !== undefined)
              await db.reviews.update(existing.id, { undone: true });
            result.duplicateReviews += 1;
            continue;
          }
          const { id: _id, ...rest } = entry;
          await db.reviews.add(rest);
        }
      },
    );

    return result;
  } finally {
    release();
  }
}

/** Копия как строка, готовая к сохранению в файл. */
export async function exportBackupJson(
  db: AppDatabase,
  options: ExportOptions = {},
): Promise<string> {
  return JSON.stringify(await exportBackup(db, options));
}

/** Имя файла с датой: копии складываются в папку и не перетирают друг друга. */
export function backupFileName(
  now: Date = new Date(),
  extension = "json",
): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `collocations-backup-${stamp}.${extension}`;
}
