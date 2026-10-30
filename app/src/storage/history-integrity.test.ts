import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, expect, it } from "vitest";
import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import {
  AppDatabase,
  importDeck,
  removeDeck,
  exportBackup,
  restoreBackup,
  recordReview,
  studiedToday,
  undoReview,
  type DeckFile,
  type BackupFile,
} from "./index";

const NOW = new Date("2026-10-30T10:00:00Z");
const scheduler = createScheduler({ enableFuzz: false });
const x = makeCard(),
  y = makeCard(),
  other = makeCard(),
  extra = makeCard();
const opened: AppDatabase[] = [];
function file(id: string, cards = [x, y], version = "v1"): DeckFile {
  return {
    meta: {
      id,
      name: id,
      version,
      language: "en",
      card_type: "cloze",
      built_at: new Date(
        NOW.getTime() + (version === "v1" ? 0 : 1),
      ).toISOString(),
      count: cards.length,
      chunks: ["cards-000.json"],
    },
    cards,
  };
}
async function database(name = `history-${opened.length}`) {
  const db = new AppDatabase(name);
  opened.push(db);
  await db.open();
  return db;
}
const snapshot = (db: AppDatabase) => exportBackup(db, { now: NOW });
const review = (db: AppDatabase, cardId = x.id, deckId = "alpha") =>
  recordReview(db, { cardId, deckId, grade: "easy", now: NOW, scheduler });
afterEach(async () => {
  for (const db of opened) {
    db.close();
    await db.delete();
  }
  opened.length = 0;
});

async function legacyOrphan(): Promise<BackupFile> {
  const source = await database();
  await importDeck(source, file("alpha", [x]));
  await review(source);
  await importDeck(source, file("alpha", [extra], "v2"));
  await source.progress.clear();
  await source.changes.clear();
  await importDeck(source, file("beta", [other]));
  const copy = await snapshot(source);
  copy.formatVersion = 1;
  delete copy.changes;
  copy.reviews = copy.reviews.map(({ deckId: _deckId, ...row }) => row);
  return copy;
}

it("неоднозначный журнал многоколодной v1-копии не присваивается локальной gamma", async () => {
  const copy = await legacyOrphan();
  const target = await database();
  await importDeck(target, file("gamma", [x]));
  const restored = await restoreBackup(target, copy, { mode: "merge" });
  expect(restored.unassignedReviews).toBe(1);
  expect((await target.reviews.toArray())[0]!.deckId).toBeNull();
  expect(await studiedToday(target, "gamma", NOW)).toEqual({
    fresh: 0,
    review: 0,
  });
  const exported = await snapshot(target);
  expect(exported.formatVersion).toBe(4);
  await restoreBackup(target, exported);
  expect((await target.reviews.toArray())[0]!.deckId).toBeNull();
  await removeDeck(target, "gamma");
  expect(await target.reviews.count()).toBe(1);
});

it("однозначный старый журнал сохраняет владельца и отклоняет пересекающийся импорт", async () => {
  const copy = await legacyOrphan();
  copy.decks = copy.decks.filter((deck) => deck.id === "alpha");
  copy.cards = copy.cards.filter((card) => card.deckId === "alpha");
  const target = await database();
  await importDeck(target, file("gamma", [x]));
  const before = await snapshot(target);
  await expect(restoreBackup(target, copy, { mode: "merge" })).rejects.toThrow(
    "одинаковые карточки",
  );
  expect(await snapshot(target)).toEqual(before);
});

it("известный владелец сиротского журнала сохраняется до явного удаления его колоды", async () => {
  const db = await database();
  await importDeck(db, file("alpha", [x]));
  await review(db);
  await importDeck(db, file("alpha", [extra], "v2"));
  await db.progress.clear();
  await db.changes.clear();
  await expect(importDeck(db, file("gamma", [x]))).rejects.toThrow(
    "одинаковые карточки",
  );
  await removeDeck(db, "alpha");
  expect(await db.reviews.count()).toBe(0);
  await expect(importDeck(db, file("gamma", [x]))).resolves.toMatchObject({
    added: 1,
  });
});

it.each([
  "cardId",
  "reviewedAt",
  "grade",
  "stateBefore",
  "elapsedDays",
  "scheduledDays",
  "typed",
  "verdict",
  "durationMs",
] as const)(
  "совпавший eventId с изменённым %s отклоняется с полным откатом",
  async (field) => {
    const db = await database();
    await importDeck(db, file("alpha"));
    await review(db);
    const copy = await snapshot(db),
      before = await snapshot(db);
    const changes = {
      cardId: y.id,
      reviewedAt: new Date(NOW.getTime() + 1).toISOString(),
      grade: "again",
      stateBefore: "review",
      elapsedDays: 1,
      scheduledDays: 1,
      typed: "changed",
      verdict: "wrong",
      durationMs: 100,
    };
    const row = copy.reviews[0]! as unknown as Record<string, unknown>;
    row[field] = changes[field];
    row.undone = true;
    copy.settings.push({ key: "must-rollback", value: true });
    await expect(restoreBackup(db, copy, { mode: "merge" })).rejects.toThrow(
      "изменены данные существующего повторения",
    );
    expect(await snapshot(db)).toEqual(before);
  },
);

it("подлинная отмена с другим локальным id и эквивалентной датой объединяется", async () => {
  const db = await database();
  await importDeck(db, file("alpha"));
  await review(db);
  const copy = await snapshot(db);
  copy.reviews[0]!.id = 999999;
  copy.reviews[0]!.reviewedAt = "2026-10-29T22:00:00.000-12:00";
  copy.reviews[0]!.undone = true;
  expect(
    (await restoreBackup(db, copy, { mode: "merge" })).duplicateReviews,
  ).toBe(1);
  expect((await db.reviews.toArray())[0]!.undone).toBe(true);
});

it("ошибочный reviewId не позволяет отменить другую карточку через API", async () => {
  const db = await database();
  await importDeck(db, file("alpha"));
  const first = await review(db);
  const second = await review(db, y.id);
  const before = await snapshot(db);
  await expect(
    undoReview(db, {
      cardId: x.id,
      reviewId: second.reviewId,
      previous: first.previous,
    }),
  ).rejects.toThrow("не принадлежит");
  expect(await snapshot(db)).toEqual(before);
});

it("миграция v4 → v5 назначает только однозначных владельцев и сохраняет сиротский журнал", async () => {
  const source = await database();
  await importDeck(source, file("alpha", [x, y]));
  await importDeck(source, file("beta", [other]));
  await review(source);
  const copy = await snapshot(source);
  const legacy = new Dexie("history-legacy");
  legacy.version(4).stores({
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
  await legacy.table("changes").bulkPut(copy.changes!);
  const { deckId: _owner, id: _id, ...entry } = copy.reviews[0]!;
  await legacy
    .table("reviews")
    .bulkAdd([entry, { ...entry, cardId: y.id, eventId: "orphan-event" }]);
  legacy.close();
  const upgraded = await database("history-legacy");
  const rows = await upgraded.reviews.toArray();
  expect(rows.find((row) => row.cardId === x.id)?.deckId).toBe("alpha");
  expect(rows.find((row) => row.cardId === y.id)?.deckId).toBeNull();
  expect(await studiedToday(upgraded, "alpha", NOW)).toEqual({
    fresh: 1,
    review: 0,
  });
  expect((await snapshot(upgraded)).reviews).toHaveLength(2);
});
