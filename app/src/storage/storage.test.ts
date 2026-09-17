import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import { AppDatabase } from "./db";
import { importDeck, listDecks, loadCards, removeDeck, type DeckFile } from "./decks";
import {
  cardHistory,
  deckCounts,
  loadProgress,
  recordReview,
  resetCard,
} from "./study";
import { DEFAULT_STUDY_SETTINGS, getStudySettings, updateStudySettings } from "./settings";
import { exportBackup, restoreBackup, BackupFormatError } from "./backup";

const scheduler = createScheduler({ enableFuzz: false });
const NOW = new Date("2026-04-01T09:00:00Z");

function deckFile(
  cards: ReturnType<typeof makeCard>[],
  version = "v1",
  id = "test-deck",
): DeckFile {
  return {
    meta: {
      id,
      name: "Тестовая колода",
      version,
      language: "en",
      card_type: "cloze",
      built_at: "2026-04-01T00:00:00Z",
      count: cards.length,
      chunks: ["cards-000.json"],
    },
    cards,
  };
}

let db: AppDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = new AppDatabase(`test-${counter}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe("импорт колоды", () => {
  it("кладёт карточки и метаданные", async () => {
    const cards = [makeCard(), makeCard(), makeCard()];
    const result = await importDeck(db, deckFile(cards), { now: NOW });

    expect(result).toMatchObject({ added: 3, updated: 0, removed: 0, skipped: false });
    expect(await loadCards(db, "test-deck")).toHaveLength(3);

    const decks = await listDecks(db);
    expect(decks[0]).toMatchObject({ id: "test-deck", version: "v1", count: 3 });
  });

  it("повторный импорт той же версии ничего не делает", async () => {
    const cards = [makeCard(), makeCard()];
    await importDeck(db, deckFile(cards), { now: NOW });
    const again = await importDeck(db, deckFile(cards), { now: NOW });

    expect(again.skipped).toBe(true);
    expect(again.added).toBe(0);
  });

  it("отдаёт карточки в порядке изучения", async () => {
    const cards = [
      makeCard({ id: "c_c", position: 30 }),
      makeCard({ id: "c_a", position: 10 }),
      makeCard({ id: "c_b", position: 20 }),
    ];
    await importDeck(db, deckFile(cards), { now: NOW });
    expect((await loadCards(db, "test-deck")).map((card) => card.id)).toEqual([
      "c_a",
      "c_b",
      "c_c",
    ]);
  });
});

describe("обновление колоды", () => {
  const original = [
    makeCard({ id: "c_keep", position: 1 }),
    makeCard({ id: "c_edit", position: 2, translation: "старый перевод" }),
    makeCard({ id: "c_gone", position: 3 }),
  ];

  beforeEach(async () => {
    await importDeck(db, deckFile(original), { now: NOW });
  });

  it("различает добавленное, изменённое, удалённое и нетронутое", async () => {
    const next = [
      original[0]!,
      makeCard({ id: "c_edit", position: 2, translation: "новый перевод" }),
      makeCard({ id: "c_new", position: 4 }),
    ];
    const result = await importDeck(db, deckFile(next, "v2"), { now: NOW });

    expect(result).toMatchObject({
      skipped: false,
      added: 1,
      updated: 1,
      removed: 1,
      unchanged: 1,
    });

    const stored = await loadCards(db, "test-deck");
    expect(stored.map((card) => card.id).sort()).toEqual(["c_edit", "c_keep", "c_new"]);
    expect(stored.find((card) => card.id === "c_edit")?.translation).toBe(
      "новый перевод",
    );
  });

  it("не трогает прогресс по сохранившимся карточкам", async () => {
    // Ради этого свойства содержимое и прогресс и разнесены по разным
    // таблицам: правка перевода не должна стоить человеку выученного.
    await recordReview(db, {
      cardId: "c_keep",
      deckId: "test-deck",
      grade: "good",
      now: NOW,
      scheduler,
    });
    const before = (await loadProgress(db, "test-deck")).get("c_keep");

    const next = [
      makeCard({ id: "c_keep", position: 1, note: "другая заметка" }),
      makeCard({ id: "c_new", position: 2 }),
    ];
    await importDeck(db, deckFile(next, "v2"), { now: NOW });

    const after = (await loadProgress(db, "test-deck")).get("c_keep");
    expect(after).toEqual(before);
  });

  it("сохраняет прогресс по исчезнувшим карточкам и сообщает о них", async () => {
    await recordReview(db, {
      cardId: "c_gone",
      deckId: "test-deck",
      grade: "good",
      now: NOW,
      scheduler,
    });

    const result = await importDeck(db, deckFile([original[0]!], "v2"), { now: NOW });
    expect(result.removed).toBe(2);
    expect(result.orphanedProgress).toBe(1);

    // Карточка вернулась в следующей сборке — вернулось и выученное.
    await importDeck(db, deckFile(original, "v3"), { now: NOW });
    const restored = (await loadProgress(db, "test-deck")).get("c_gone");
    expect(restored?.reps).toBe(1);
  });
});

describe("удаление колоды", () => {
  it("уносит карточки, прогресс и журнал", async () => {
    const cards = [makeCard({ id: "c_1" }), makeCard({ id: "c_2" })];
    await importDeck(db, deckFile(cards), { now: NOW });
    await recordReview(db, {
      cardId: "c_1",
      deckId: "test-deck",
      grade: "good",
      now: NOW,
      scheduler,
    });

    await removeDeck(db, "test-deck");

    expect(await listDecks(db)).toHaveLength(0);
    expect(await loadCards(db, "test-deck")).toHaveLength(0);
    expect(await db.progress.count()).toBe(0);
    expect(await db.reviews.count()).toBe(0);
  });
});

describe("запись повторения", () => {
  beforeEach(async () => {
    await importDeck(db, deckFile([makeCard({ id: "c_1" })]), { now: NOW });
  });

  it("сохраняет расписание и запись журнала вместе", async () => {
    const result = await recordReview(db, {
      cardId: "c_1",
      deckId: "test-deck",
      grade: "good",
      now: NOW,
      typed: "make",
      verdict: "correct",
      durationMs: 4200,
      scheduler,
    });

    expect(result.progress.reps).toBe(1);
    expect(result.intervalDays).toBeGreaterThan(0);

    const history = await cardHistory(db, "c_1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      cardId: "c_1",
      grade: "good",
      stateBefore: "new",
      typed: "make",
      verdict: "correct",
      durationMs: 4200,
    });
  });

  it("журнал только дополняется", async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "again", now: NOW, scheduler });
    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "good", now: later, scheduler });

    const history = await cardHistory(db, "c_1");
    expect(history.map((entry) => entry.grade)).toEqual(["again", "good"]);
  });

  it("сброс карточки не стирает историю", async () => {
    // Журнал описывает то, что действительно происходило; переписывать его
    // задним числом нельзя даже по просьбе пользователя.
    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "good", now: NOW, scheduler });
    await resetCard(db, "c_1");

    expect(await db.progress.count()).toBe(0);
    expect(await cardHistory(db, "c_1")).toHaveLength(1);
  });
});

describe("сводка по колоде", () => {
  it("считает новые, ждущие повторения и начатые", async () => {
    const cards = [makeCard({ id: "c_1" }), makeCard({ id: "c_2" }), makeCard({ id: "c_3" })];
    await importDeck(db, deckFile(cards), { now: NOW });

    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "good", now: NOW, scheduler });

    const sameDay = await deckCounts(db, "test-deck", NOW);
    expect(sameDay).toMatchObject({ total: 3, fresh: 2, learning: 1, review: 0 });

    const laterOn = await deckCounts(db, "test-deck", new Date(NOW.getTime() + 86_400_000));
    expect(laterOn.due).toBe(1);
  });
});

describe("настройки", () => {
  it("по умолчанию отдаёт разумные значения", async () => {
    expect(await getStudySettings(db)).toEqual(DEFAULT_STUDY_SETTINGS);
  });

  it("сохраняет изменения и дополняет их умолчаниями", async () => {
    await updateStudySettings(db, { newPerDay: 25 });
    const settings = await getStudySettings(db);

    expect(settings.newPerDay).toBe(25);
    // Настройка, которой человек не касался, остаётся значением по умолчанию,
    // а не превращается в undefined.
    expect(settings.reviewsPerDay).toBe(DEFAULT_STUDY_SETTINGS.reviewsPerDay);
  });
});

describe("резервная копия", () => {
  async function seed(): Promise<void> {
    await importDeck(db, deckFile([makeCard({ id: "c_1" }), makeCard({ id: "c_2" })]), {
      now: NOW,
    });
    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "good", now: NOW, scheduler });
    await updateStudySettings(db, { newPerDay: 7 });
  }

  it("восстанавливается на чистой базе без файла колоды", async () => {
    // Копия должна быть самодостаточной: иначе восстановление зависело бы от
    // наличия той же версии колоды, а это ровно та зависимость, от которой
    // копия и спасает.
    await seed();
    const backup = await exportBackup(db, { now: NOW });

    const fresh = new AppDatabase("test-restore");
    await fresh.open();
    try {
      const result = await restoreBackup(fresh, JSON.parse(JSON.stringify(backup)));
      expect(result.mode).toBe("replace");
      expect(await loadCards(fresh, "test-deck")).toHaveLength(2);
      expect((await loadProgress(fresh, "test-deck")).get("c_1")?.reps).toBe(1);
      expect((await getStudySettings(fresh)).newPerDay).toBe(7);
      expect(await fresh.reviews.count()).toBe(1);
    } finally {
      fresh.close();
      await fresh.delete();
    }
  });

  it("облегчённая копия обходится без карточек", async () => {
    await seed();
    const light = await exportBackup(db, { includeCards: false, now: NOW });
    expect(light.cards).toHaveLength(0);
    expect(light.progress).toHaveLength(1);
  });

  it("слияние берёт более свежий прогресс и не двоит журнал", async () => {
    await seed();
    const backup = JSON.parse(JSON.stringify(await exportBackup(db, { now: NOW })));

    // На «другом устройстве» ту же карточку повторили позже.
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    await recordReview(db, { cardId: "c_1", deckId: "test-deck", grade: "good", now: later, scheduler });

    const result = await restoreBackup(db, backup, { mode: "merge" });

    expect(result.duplicateReviews).toBe(1);
    expect(await db.reviews.count()).toBe(2);
    const merged = (await loadProgress(db, "test-deck")).get("c_1");
    expect(merged?.reps).toBe(2);
    expect(merged?.lastReview).toBe(later.toISOString());
  });

  it("отказывается от чужого и слишком нового файла", async () => {
    await expect(restoreBackup(db, { format: "anki" })).rejects.toBeInstanceOf(
      BackupFormatError,
    );
    await expect(
      restoreBackup(db, {
        format: "collocation-srs-backup",
        formatVersion: 99,
        decks: [],
        cards: [],
        progress: [],
        reviews: [],
        settings: [],
      }),
    ).rejects.toBeInstanceOf(BackupFormatError);
    await expect(restoreBackup(db, null)).rejects.toBeInstanceOf(BackupFormatError);
  });
});
