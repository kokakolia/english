import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import { AppDatabase } from "./db";
import { importDeck, removeDeck, type DeckFile } from "./decks";
import { exportBackup, restoreBackup, BackupFormatError } from "./backup";
import { recordReview } from "./study";
import { DeckOwnershipError } from "./ownership";

const NOW = new Date("2026-10-29T10:00:00Z");
const scheduler = createScheduler({ enableFuzz: false });
const shared = makeCard(), extra = makeCard();
const opened: AppDatabase[] = [];
function file(id: string, cards = [shared], version = "v1"): DeckFile {
  return { meta: { id, name: id, version, language: "en", card_type: "cloze", built_at: new Date(NOW.getTime() + (version === "v1" ? 0 : 1)).toISOString(), count: cards.length, chunks: ["cards-000.json"] }, cards };
}
async function database() { const db = new AppDatabase(`ownership-${opened.length}`); opened.push(db); await db.open(); return db; }
const copy = (db: AppDatabase) => exportBackup(db, { now: NOW });
async function review(db: AppDatabase, deckId: string, cardId = shared.id) {
  return recordReview(db, { deckId, cardId, grade: "easy", now: NOW, scheduler });
}
afterEach(async () => { for (const db of opened) { db.close(); await db.delete(); } opened.length = 0; });

it("отклоняет пересекающуюся колоду целиком, сохраняя содержимое и прогресс первой", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  const before = await copy(db);
  await expect(importDeck(db, file("subset", [extra, shared]))).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it.each([true, false])("слияние полной/облегчённой копии с конфликтующими ID атомарно: cards=%s", async includeCards => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  const source = await database(); await importDeck(source, file("subset", [extra, shared])); await review(source, "subset");
  const incoming = await exportBackup(source, { includeCards }); const before = await copy(db);
  await expect(restoreBackup(db, incoming, { mode: "merge" })).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it("копия с разными владельцами карточки и прогресса отклоняется до replace", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  const incoming = await copy(db); incoming.decks.push({ ...incoming.decks[0]!, id: "subset", count: 0 });
  incoming.progress[0]!.deckId = "subset";
  const before = await copy(db);
  await expect(restoreBackup(db, incoming)).rejects.toBeInstanceOf(BackupFormatError);
  expect(await copy(db)).toEqual(before);
});

it("сиротский прогресс не передаётся чужой колоде", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  await importDeck(db, file("full", [extra], "v2"));
  const before = await copy(db);
  await expect(importDeck(db, file("subset"))).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it("старый облегчённый журнал без прогресса не смешивается с чужой колодой", async () => {
  const db = await database(); await importDeck(db, file("full"));
  const source = await database(); await importDeck(source, file("subset")); await review(source, "subset");
  const incoming = await exportBackup(source, { includeCards: false });
  incoming.formatVersion = 1; incoming.progress = []; delete incoming.changes;
  const before = await copy(db);
  await expect(restoreBackup(db, incoming, { mode: "merge" })).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it("удаление повреждённой старой колоды не стирает чужой журнал", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  // Воспроизводим результат старой ошибки без нового защищённого импортёра.
  await db.decks.put({ ...(await db.decks.get("full"))!, id: "subset" });
  await db.cards.update(shared.id, { deckId: "subset" });
  const before = await copy(db);
  await expect(removeDeck(db, "subset")).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it("непересекающиеся колоды импортируются и удаляются независимо", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  await importDeck(db, file("other", [extra])); await review(db, "other", extra.id);
  await removeDeck(db, "other");
  expect((await db.cards.toArray()).map(card => card.id)).toEqual([shared.id]);
  expect((await db.progress.toArray()).map(row => row.cardId)).toEqual([shared.id]);
  expect((await db.reviews.toArray()).map(row => row.cardId)).toEqual([shared.id]);
});

it("запись оценки с чужой колодой не меняет владельца прогресса", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  const before = await copy(db);
  await expect(review(db, "other")).rejects.toBeInstanceOf(DeckOwnershipError);
  expect(await copy(db)).toEqual(before);
});

it("явная полная замена может восстановить другую колоду вместо текущей", async () => {
  const db = await database(); await importDeck(db, file("full")); await review(db, "full");
  const source = await database(); await importDeck(source, file("subset")); await review(source, "subset");
  const incoming = await copy(source);
  await restoreBackup(db, incoming, { mode: "replace" });
  const restored = await copy(db);
  // Локальные номера строк назначаются заново; eventId и данные сохраняются.
  expect({ ...restored, reviews: restored.reviews.map(({ id: _id, ...row }) => row) })
    .toEqual({ ...incoming, reviews: incoming.reviews.map(({ id: _id, ...row }) => row) });
});
