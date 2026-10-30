import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import {
  AppDatabase,
  importDeck,
  exportBackup,
  restoreBackup,
  recordReview,
  studiedToday,
  updateStudySettings,
  getStudySettings,
  type DeckFile,
} from "./index";

const NOW = new Date("2026-10-30T10:00:00Z");
const scheduler = createScheduler({ enableFuzz: false });
const card = makeCard();
const file: DeckFile = {
  meta: {
    id: "policy",
    name: "Policy",
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
async function database(name = `policy-${opened.length}`) {
  const db = new AppDatabase(name);
  opened.push(db);
  await db.open();
  return db;
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

it("merge сохраняет местные лимиты и настройки, добавляя отсутствующие ключи", async () => {
  await updateStudySettings(db, { newPerDay: 0, reviewsPerDay: 0 });
  const copy = await exportBackup(db);
  await updateStudySettings(db, { newPerDay: 15, reviewsPerDay: 120 });
  await db.settings.put({ key: "selectedDeck", value: "local" });
  copy.settings.push(
    { key: "selectedDeck", value: "old" },
    { key: "extra", value: "incoming" },
  );
  const result = await restoreBackup(db, copy, { mode: "merge" });
  expect(await getStudySettings(db)).toMatchObject({
    newPerDay: 15,
    reviewsPerDay: 120,
  });
  expect((await db.settings.get("selectedDeck"))?.value).toBe("local");
  expect((await db.settings.get("extra"))?.value).toBe("incoming");
  expect(result.settings).toBe(1);
});

it("активные умолчания 15/120 сохраняются и без строки study в базе", async () => {
  expect(await db.settings.get("study")).toBeUndefined();
  const copy = await exportBackup(db);
  copy.settings.push({
    key: "study",
    value: { newPerDay: 0, reviewsPerDay: 0 },
  });
  await restoreBackup(db, copy, { mode: "merge" });
  expect(await getStudySettings(db)).toMatchObject({
    newPerDay: 15,
    reviewsPerDay: 120,
  });
});

it.each(["replace", "merge"] as const)(
  "на пустом устройстве настройки копии восстанавливаются: %s",
  async (mode) => {
    await updateStudySettings(db, { newPerDay: 7, reviewsPerDay: 40 });
    const fresh = await database();
    await restoreBackup(fresh, await exportBackup(db), { mode });
    expect(await getStudySettings(fresh)).toMatchObject({
      newPerDay: 7,
      reviewsPerDay: 40,
    });
  },
);

function offset(value: string, hours: number) {
  const shifted = new Date(Date.parse(value) + hours * 3600000)
    .toISOString()
    .slice(0, -1);
  return `${shifted}${hours < 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

it("эквивалентные даты со смещениями не меняют расход дневного лимита", async () => {
  await recordReview(db, {
    cardId: card.id,
    deckId: file.meta.id,
    grade: "easy",
    now: NOW,
    scheduler,
  });
  const expected = await studiedToday(db, file.meta.id, NOW);
  expect(expected.fresh).toBe(1);
  const copy = await exportBackup(db);
  copy.reviews[0]!.reviewedAt = offset(copy.reviews[0]!.reviewedAt, -12);
  copy.progress[0]!.due = offset(copy.progress[0]!.due, 5);
  copy.progress[0]!.lastReview = offset(copy.progress[0]!.lastReview!, -12);
  copy.decks[0]!.builtAt = offset(copy.decks[0]!.builtAt, 9);
  copy.decks[0]!.importedAt = offset(copy.decks[0]!.importedAt, -4);
  copy.changes![0]!.changedAt = offset(copy.changes![0]!.changedAt, 1);
  const fresh = await database();
  await restoreBackup(fresh, copy);
  expect(await studiedToday(fresh, file.meta.id, NOW)).toEqual(expected);
  const restored = await exportBackup(fresh);
  expect(restored.reviews[0]!.reviewedAt).toBe(NOW.toISOString());
  expect(restored.progress[0]!.lastReview).toBe(NOW.toISOString());
  expect(restored.changes![0]!.changedAt).toBe(NOW.toISOString());
  expect(restored.decks[0]!.builtAt).toBe(NOW.toISOString());
  expect(copy.reviews[0]!.reviewedAt.endsWith("-12:00")).toBe(true);
});

it("миграция v3 → v4 исправляет даты уже импортированного журнала, сохраняя ID событий", async () => {
  await recordReview(db, {
    cardId: card.id,
    deckId: file.meta.id,
    grade: "easy",
    now: NOW,
    scheduler,
  });
  const copy = await exportBackup(db);
  const legacy = new Dexie("policy-legacy");
  legacy.version(3).stores({
    decks: "id, importedAt",
    cards: "id, deckId, position, headword, relation, band, cefr",
    progress: "cardId, deckId, due, state, [deckId+due]",
    reviews: "++id, &eventId, cardId, reviewedAt, [cardId+reviewedAt]",
    settings: "key",
    changes: "cardId, deckId",
  });
  await legacy.open();
  await legacy.table("decks").bulkPut(copy.decks);
  await legacy.table("cards").bulkPut(copy.cards);
  await legacy.table("progress").bulkPut(copy.progress);
  await legacy.table("reviews").bulkPut(
    copy.reviews.map((row) => ({
      ...row,
      reviewedAt: offset(row.reviewedAt, -12),
    })),
  );
  await legacy.table("changes").bulkPut(copy.changes!);
  legacy.close();
  const upgraded = await database("policy-legacy");
  expect(await studiedToday(upgraded, file.meta.id, NOW)).toEqual({
    fresh: 1,
    review: 0,
  });
  expect((await upgraded.reviews.toArray())[0]).toEqual(copy.reviews[0]);
});
