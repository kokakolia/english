import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import { gzip, gunzipIfNeeded, saveBackupFile } from "../app/backup-file";
import { BACKUP_LIMITS } from "./backup-limits";
import {
  AppDatabase,
  importDeck,
  exportBackup,
  exportBackupJson,
  restoreBackup,
  recordReview,
  resetCard,
  type DeckFile,
} from "./index";
import { deckContentHash } from "./integrity";
import { createHash } from "node:crypto";

const NOW = new Date("2026-10-30T10:00:00Z");
const scheduler = createScheduler({ enableFuzz: false });
const card = makeCard();
const file: DeckFile = {
  meta: {
    id: "boundaries",
    name: "Boundaries",
    version: "v1",
    language: "en",
    card_type: "cloze",
    built_at: NOW.toISOString(),
    count: 1,
    chunks: ["cards-000.json"],
  },
  cards: [card],
};
const opened: AppDatabase[] = [];
let db: AppDatabase;
async function database() {
  const database = new AppDatabase(`boundaries-${opened.length}`);
  opened.push(database);
  await database.open();
  return database;
}
async function review(database = db) {
  return recordReview(database, {
    cardId: card.id,
    deckId: file.meta.id,
    grade: "easy",
    now: NOW,
    scheduler,
  });
}
beforeEach(async () => {
  db = await database();
  await importDeck(db, file);
});
afterEach(async () => {
  for (const db of opened) {
    db.close();
    await db.delete();
  }
  opened.length = 0;
});

it.each(["stability", "difficulty"] as const)(
  "нулевой %s изученной карточки отклоняется до восстановления",
  async (field) => {
    await review();
    const backup = await exportBackup(db);
    const before = await db.progress.get(card.id);
    backup.progress[0]![field] = 0;
    await expect(restoreBackup(db, backup)).rejects.toThrow("progress");
    expect(await db.progress.get(card.id)).toEqual(before);
    expect(await db.reviews.count()).toBe(1);
  },
);

it.each(["NaN", "wrong-card", "infinite-interval"])(
  "невалидный результат планировщика %s не меняет ни одну таблицу",
  async (kind) => {
    const broken = {
      ...scheduler,
      review: vi.fn((...args: Parameters<typeof scheduler.review>) => {
        const result = scheduler.review(...args);
        if (kind === "NaN") result.progress.stability = NaN;
        if (kind === "wrong-card") result.progress.cardId = "another";
        if (kind === "infinite-interval") result.intervalDays = Infinity;
        return result;
      }),
    };
    await expect(
      recordReview(db, {
        cardId: card.id,
        deckId: file.meta.id,
        grade: "again",
        now: NOW,
        scheduler: broken,
      }),
    ).rejects.toThrow("Планировщик");
    expect(await db.progress.count()).toBe(0);
    expect(await db.reviews.count()).toBe(0);
    expect(await db.changes.count()).toBe(0);
  },
);

it("повреждённая старая база не экспортируется как успешная копия; сброс карточки восстанавливает экспорт", async () => {
  await review();
  await db.progress.update(card.id, { stability: NaN });
  await expect(exportBackupJson(db)).rejects.toThrow("progress");
  await expect(review()).rejects.toThrow("Некорректный прогресс");
  await resetCard(db, card.id, NOW);
  expect(JSON.parse(await exportBackupJson(db)).progress).toEqual([]);
});

it("импорт → оценка → gzip-экспорт → восстановление → новая оценка → восстановление сохраняют конечные числа", async () => {
  await review();
  const second = await database();
  const json = await exportBackupJson(db);
  await restoreBackup(
    second,
    JSON.parse(await gunzipIfNeeded(await gzip(json))),
  );
  await recordReview(second, {
    cardId: card.id,
    deckId: file.meta.id,
    grade: "again",
    now: new Date(NOW.getTime() + 86400000),
    scheduler,
  });
  const third = await database();
  await restoreBackup(third, JSON.parse(await exportBackupJson(second)));
  expect(await third.progress.get(card.id)).toEqual(
    await second.progress.get(card.id),
  );
  expect(Number.isFinite((await third.progress.get(card.id))!.stability)).toBe(
    true,
  );
  expect(await third.reviews.count()).toBe(2);
});

it("старая копия без полного хэша проверяется по опубликованной версии", async () => {
  const hash = await deckContentHash(file.cards);
  const published: DeckFile = {
    ...file,
    meta: {
      ...file.meta,
      version: hash.slice(0, 12),
      built_at: new Date(NOW.getTime() + 1).toISOString(),
      integrity: {
        algorithm: "sha256-canonical-json-v1",
        chunks: { "cards-000.json": hash },
      },
    },
  };
  await importDeck(db, published);
  const backup = await exportBackup(db);
  delete backup.decks[0]!.contentHash;
  backup.cards[0]!.answer = "wrong";
  await expect(restoreBackup(db, backup)).rejects.toThrow("контрольной сумме");
  expect((await db.cards.get(card.id))?.answer).toBe(card.answer);
});

it("полный хэш защищает и старую колоду с непрозрачной версией", async () => {
  const backup = await exportBackup(db);
  backup.cards[0]!.answer = "wrong";
  await expect(restoreBackup(db, backup)).rejects.toThrow("контрольной сумме");
});

it("старые версии SHA-1 по пяти полям по-прежнему восстанавливаются", async () => {
  const legacy = {
    ...file,
    meta: {
      ...file.meta,
      version: createHash("sha1")
        .update(
          `${card.id}|${card.text}|${card.answer}|${card.translation || ""}|${card.note || ""}`,
        )
        .digest("hex")
        .slice(0, 12),
      built_at: new Date(NOW.getTime() + 1).toISOString(),
    },
  };
  await importDeck(db, legacy);
  await review();
  const copy = await exportBackup(db);
  delete copy.decks[0]!.contentHash;
  copy.formatVersion = 1;
  delete copy.changes;
  const second = await database();
  await restoreBackup(second, copy);
  expect((await second.cards.get(card.id))?.answer).toBe(card.answer);
  expect(await second.progress.get(card.id)).toEqual(
    await db.progress.get(card.id),
  );
  expect(await exportBackupJson(second)).toBeTruthy();
});

it("оригинал исправляет изменённую legacy-копию даже при совпадении версии и числа карточек", async () => {
  await review();
  const backup = await exportBackup(db);
  delete backup.decks[0]!.contentHash;
  backup.cards[0]!.answer = "wrong";
  await restoreBackup(db, backup);
  const progress = await db.progress.get(card.id);
  const result = await importDeck(db, file);
  expect(result).toMatchObject({ skipped: false, updated: 1 });
  expect((await db.cards.get(card.id))?.answer).toBe(card.answer);
  expect(await db.progress.get(card.id)).toEqual(progress);
  expect(await db.reviews.count()).toBe(1);
});

it("экспорт JSON соблюдает тот же предел байтов UTF-8, что чтение", async () => {
  await db.settings.put({ key: "note", value: "Я".repeat(1000) });
  const json = await exportBackupJson(db, { now: NOW });
  const bytes = new Blob([json]).size;
  expect(bytes).toBeGreaterThan(json.length);
  await expect(
    exportBackupJson(
      db,
      { now: NOW },
      { ...BACKUP_LIMITS, unpackedBytes: bytes - 1 },
    ),
  ).rejects.toThrow("слишком большая");
  const limits = { ...BACKUP_LIMITS, unpackedBytes: bytes };
  expect(
    await gunzipIfNeeded(
      await gzip(await exportBackupJson(db, { now: NOW }, limits), limits),
      limits,
    ),
  ).toBe(json);
});

it("слишком большой файл не открывает диалог и не начинает запись", async () => {
  const file = new Blob(["test"]);
  vi.spyOn(file, "size", "get").mockReturnValue(BACKUP_LIMITS.fileBytes + 1);
  const picker = vi.fn();
  vi.stubGlobal("window", { showDirectoryPicker: picker });
  try {
    await expect(saveBackupFile(db, "too-large.json.gz", file)).rejects.toThrow(
      "Файл копии слишком большой",
    );
    expect(picker).not.toHaveBeenCalled();
    expect(await db.settings.count()).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
