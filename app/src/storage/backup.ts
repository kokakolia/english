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

import type { AppDatabase, StoredCard, StoredDeck, StoredProgress, StoredReview } from "./db";
import type { SettingRow } from "./db";

export const BACKUP_FORMAT = "collocation-srs-backup";
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  decks: StoredDeck[];
  cards: StoredCard[];
  progress: StoredProgress[];
  reviews: StoredReview[];
  settings: SettingRow[];
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
  const includeCards = options.includeCards ?? true;
  const [decks, cards, progress, reviews, settings] = await Promise.all([
    db.decks.toArray(),
    includeCards ? db.cards.toArray() : Promise.resolve([]),
    db.progress.toArray(),
    db.reviews.toArray(),
    db.settings.toArray(),
  ]);

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    decks,
    cards,
    progress,
    reviews,
    settings,
  };
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
  if (typeof file.formatVersion !== "number") {
    throw new BackupFormatError("в копии не указана версия формата");
  }
  if (file.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `копия сделана более новой версией приложения (формат ${file.formatVersion})`,
    );
  }
  for (const key of ["decks", "progress", "reviews", "settings"] as const) {
    if (!Array.isArray(file[key])) {
      throw new BackupFormatError(`в копии нет раздела «${key}»`);
    }
  }
}

export type RestoreMode = "replace" | "merge";

export interface RestoreResult {
  mode: RestoreMode;
  decks: number;
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

/** Какая из двух записей прогресса новее. */
function newer(left: StoredProgress, right: StoredProgress): StoredProgress {
  const leftTime = left.lastReview ?? "";
  const rightTime = right.lastReview ?? "";
  if (leftTime === rightTime) return left.reps >= right.reps ? left : right;
  return leftTime > rightTime ? left : right;
}

export async function restoreBackup(
  db: AppDatabase,
  data: unknown,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  assertBackup(data);
  const mode = options.mode ?? "replace";
  const result: RestoreResult = {
    mode,
    decks: data.decks.length,
    cards: data.cards?.length ?? 0,
    progress: data.progress.length,
    reviews: data.reviews.length,
    settings: data.settings.length,
    duplicateReviews: 0,
  };

  await db.transaction(
    "rw",
    db.decks,
    db.cards,
    db.progress,
    db.reviews,
    db.settings,
    async () => {
      if (mode === "replace") {
        await Promise.all([
          db.decks.clear(),
          db.cards.clear(),
          db.progress.clear(),
          db.reviews.clear(),
          db.settings.clear(),
        ]);
      }

      await db.decks.bulkPut(data.decks);
      if (data.cards.length > 0) await db.cards.bulkPut(data.cards);
      await db.settings.bulkPut(data.settings);

      if (mode === "replace") {
        await db.progress.bulkPut(data.progress);
        // Идентификаторы журнала присваивает база: переносим записи без них,
        // иначе можно затереть чужую строку с тем же номером.
        await db.reviews.bulkAdd(data.reviews.map(({ id: _id, ...entry }) => entry));
        return;
      }

      const merged: StoredProgress[] = [];
      for (const incoming of data.progress) {
        const existing = await db.progress.get(incoming.cardId);
        merged.push(existing === undefined ? incoming : newer(existing, incoming));
      }
      await db.progress.bulkPut(merged);

      // Повторение однозначно определяется карточкой и моментом времени:
      // одно и то же событие не может произойти дважды в одну миллисекунду.
      for (const entry of data.reviews) {
        const exists = await db.reviews
          .where("[cardId+reviewedAt]")
          .equals([entry.cardId, entry.reviewedAt])
          .count();
        if (exists > 0) {
          result.duplicateReviews += 1;
          continue;
        }
        const { id: _id, ...rest } = entry;
        await db.reviews.add(rest);
      }
    },
  );

  return result;
}

/** Копия как строка, готовая к сохранению в файл. */
export async function exportBackupJson(
  db: AppDatabase,
  options: ExportOptions = {},
): Promise<string> {
  return JSON.stringify(await exportBackup(db, options));
}

/** Имя файла с датой: копии складываются в папку и не перетирают друг друга. */
export function backupFileName(now: Date = new Date(), extension = "json"): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `collocations-backup-${stamp}.${extension}`;
}
