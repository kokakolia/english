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
import { withReviewIds, sameReviewContent } from "./review-id";
import { withReviewOwners, provesReviewOwner } from "./review-ownership";
import { utcDeck, utcProgress, utcReview, utcChange } from "./dates";
import { assertAvailableOwners, assertOwners } from "./ownership";
import { deckContentHash, legacyDeckVersion } from "./integrity";
import {
  BACKUP_LIMITS,
  checkBackupJsonSize,
  type BackupLimits,
} from "./backup-limits";
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
export const BACKUP_FORMAT_VERSION = 4;

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
  rows.push(
    ...withReviewOwners(data.reviews, data).flatMap((row) =>
      row.deckId === null ? [] : [{ cardId: row.cardId, deckId: row.deckId }],
    ),
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

    const backup: BackupFile = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? new Date()).toISOString(),
      decks,
      cards,
      progress,
      reviews: withReviewOwners(withReviewIds(reviews), {
        decks,
        cards,
        progress,
        changes,
      }),
      settings: settings.filter((row) => row.key !== "backupFolder"),
      changes,
    };
    // Проверяем исходную базу до JSON.stringify: NaN иначе превратится в null.
    assertBackup(backup);
    const hashes = await verifyDeckContents(backup);
    backup.decks = backup.decks.map((deck) =>
      hashes.has(deck.id)
        ? { ...deck, contentHash: hashes.get(deck.id)! }
        : deck,
    );
    return backup;
  } finally {
    release();
  }
}

export class BackupFormatError extends Error {}

async function verifyDeckContents(
  data: BackupFile,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const deck of data.decks) {
    const cards = data.cards.filter((card) => card.deckId === deck.id);
    if (cards.length !== deck.count) continue; // Облегчённая копия без содержимого.
    const hash = await deckContentHash(cards);
    if (
      (deck.contentHash !== undefined && deck.contentHash !== hash) ||
      (/^[0-9a-f]{12}$/.test(deck.version) &&
        hash.slice(0, 12) !== deck.version &&
        (await legacyDeckVersion(cards)) !== deck.version)
    )
      throw new BackupFormatError(
        `содержимое колоды «${deck.name}» не соответствует контрольной сумме`,
      );
    hashes.set(deck.id, hash);
  }
  return hashes;
}

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
    [
      "reviews",
      file.reviews!,
      (row) =>
        validReview(row) &&
        (file.formatVersion! < 4 ||
          (object(row) && (row.deckId === null || text(row.deckId)))),
      null,
    ],
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
    (file.formatVersion! >= 3 && identified.length !== file.reviews!.length)
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
  if (
    file.reviews!.some(
      (row) => typeof row.deckId === "string" && !deckIds.has(row.deckId),
    )
  )
    throw new BackupFormatError("повторение ссылается на неизвестную колоду");
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
  /** Сохранены отдельно и не расходуют лимиты какой-либо колоды. */
  unassignedReviews: number;
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
  input: unknown,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const release = updateSafety.begin();
  try {
    assertBackup(input);
    const data: BackupFile = {
      ...input,
      decks: input.decks.map(utcDeck),
      progress: input.progress.map(utcProgress),
      changes: input.changes?.map(utcChange),
      reviews: input.reviews.map(utcReview),
    };
    const hashes = await verifyDeckContents(data);
    // Старые ID вычисляются по исходным полям, как в миграции v3; сами даты канонизируются.
    const incomingReviews = withReviewOwners(
      withReviewIds(input.reviews).map(utcReview),
      data,
    );
    data.reviews = incomingReviews;
    const mode = options.mode ?? "replace";
    const result: RestoreResult = {
      mode,
      decks: data.decks.length,
      cards: 0,
      progress: data.progress.length,
      reviews: data.reviews.length,
      settings: data.settings.length,
      duplicateReviews: 0,
      unassignedReviews: incomingReviews.filter((row) => row.deckId === null)
        .length,
    };

    await db.transaction(
      "rw",
      [db.decks, db.cards, db.progress, db.reviews, db.settings, db.changes],
      async () => {
        // Уже используемые умолчания тоже являются местной настройкой, даже
        // если пользователь ещё не создавал строку study в базе.
        const hadLocalData =
          mode === "merge" &&
          ((await db.decks.count()) > 0 ||
            (await db.progress.count()) > 0 ||
            (await db.reviews.count()) > 0 ||
            (await db.changes.count()) > 0);
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
            await db.decks.put(
              hashes.has(deck.id)
                ? { ...deck, contentHash: hashes.get(deck.id)! }
                : deck,
            );
            if (complete) {
              await db.cards.where("deckId").equals(deck.id).delete();
              await db.cards.bulkPut(cards);
              result.cards += cards.length;
            }
          } else if (existing.version === deck.version && complete) {
            await db.cards.where("deckId").equals(deck.id).delete();
            await db.cards.bulkPut(cards);
            await db.decks.put({
              ...existing,
              contentHash: hashes.get(deck.id)!,
            });
            result.cards += cards.length;
          }
        }
        const settings = data.settings.filter(
          (row) => row.key !== "backupFolder",
        );
        const existingSettings =
          mode === "merge"
            ? await db.settings.bulkGet(settings.map((row) => row.key))
            : [];
        const toWrite = settings.filter(
          (_, index) =>
            mode === "replace" ||
            (existingSettings[index] === undefined &&
              !(hadLocalData && settings[index]!.key === "study")),
        );
        await db.settings.bulkPut(toWrite);
        result.settings = toWrite.length;

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
            const localOwner = existing.deckId ?? null;
            const incomingOwner = entry.deckId;
            if (
              !sameReviewContent(existing, entry) ||
              (localOwner !== null &&
                incomingOwner !== null &&
                localOwner !== incomingOwner)
            )
              throw new BackupFormatError(
                "В копии изменены данные существующего повторения; восстановление отменено.",
              );
            const refinedOwner =
              localOwner === null &&
              incomingOwner !== null &&
              provesReviewOwner(entry, data, input.formatVersion < 4)
                ? incomingOwner
                : localOwner;
            if (existing.id !== undefined)
              await db.reviews.update(existing.id, {
                deckId: refinedOwner,
                ...(entry.undone ? { undone: true } : {}),
              });
            if (incomingOwner === null && refinedOwner !== null)
              result.unassignedReviews--;
            if (incomingOwner !== null && refinedOwner === null)
              result.unassignedReviews++;
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
  limits: BackupLimits = BACKUP_LIMITS,
): Promise<string> {
  const json = JSON.stringify(await exportBackup(db, options));
  checkBackupJsonSize(new Blob([json]).size, limits);
  return json;
}

/** Имя файла с датой: копии складываются в папку и не перетирают друг друга. */
export function backupFileName(
  now: Date = new Date(),
  extension = "json",
): string {
  const stamp = now.toISOString().slice(0, 23).replace(/[:T.]/g, "-");
  return `collocations-backup-${stamp}-${crypto.randomUUID()}.${extension}`;
}
