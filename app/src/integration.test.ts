/**
 * Сквозная проверка: настоящая колода, настоящее хранилище, несколько дней
 * занятий.
 *
 * Модульные тесты проверяют части по отдельности и на выдуманных данных.
 * Здесь собирается всё вместе — файл из пайплайна, импорт в базу, очередь дня,
 * ответы, запись прогресса, резервная копия. Именно на стыках ломаются вещи,
 * которые каждая часть по отдельности считает своими: формат поля, порядок
 * карточек, переживание прогресса при обновлении колоды.
 */

import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildQueue, checkAnswer, createScheduler, createSession } from "./srs";
import type { DeckCard } from "./srs";
import {
  AppDatabase,
  deckCounts,
  exportBackup,
  importDeck,
  loadCards,
  loadProgress,
  recordReview,
  restoreBackup,
  type DeckFile,
  type DeckMeta,
} from "./storage";

const DECK_DIR = new URL("../../decks/en-collocations/", import.meta.url);
const scheduler = createScheduler({ enableFuzz: false });
const START = new Date("2026-06-01T09:00:00Z");
const DAY_MS = 86_400_000;

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DECK_DIR), "utf-8")) as T;
}

const meta = readJson<DeckMeta>("deck.json");
const deck: DeckFile = {
  meta,
  cards: meta.chunks.flatMap((chunk) => readJson<DeckCard[]>(chunk)),
};

let db: AppDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = new AppDatabase(`integration-${counter}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe("колода из пайплайна в хранилище", () => {
  it("импортируется целиком", async () => {
    const result = await importDeck(db, deck, { now: START });
    expect(result.added).toBe(meta.count);
    expect(result.removed).toBe(0);

    const stored = await loadCards(db, meta.id);
    expect(stored).toHaveLength(meta.count);
    // Порядок изучения не должен зависеть от того, как база вернула строки.
    expect(stored.map((card) => card.position)).toEqual(
      [...stored.map((card) => card.position)].sort((a, b) => a - b),
    );
  });

  it("сводка на чистой базе показывает весь материал новым", async () => {
    await importDeck(db, deck, { now: START });
    expect(await deckCounts(db, meta.id, START)).toMatchObject({
      total: meta.count,
      fresh: meta.count,
      due: 0,
    });
  });
});

describe("неделя занятий", () => {
  it("проходит от первого дня до седьмого", async () => {
    await importDeck(db, deck, { now: START });
    const cards = await loadCards(db, meta.id);

    let answersGiven = 0;
    let correctTyped = 0;

    for (let day = 0; day < 7; day += 1) {
      const now = new Date(START.getTime() + day * DAY_MS);
      const progress = await loadProgress(db, meta.id);
      const queue = buildQueue({
        cards,
        progress,
        settings: { newPerDay: 10, reviewsPerDay: 60, siblingGap: 4, seed: day + 1 },
        now,
      });

      const session = createSession(queue.cards, { againGap: 3 });
      let guard = 0;
      while (!session.isFinished() && guard < 500) {
        guard += 1;
        const card = session.current();
        if (card === null) break;

        // «Учащийся» набирает словарную форму партнёра: она должна
        // засчитываться наравне с формой из предложения.
        const typed = card.answers[0] ?? card.answer;
        const check = checkAnswer(typed, card);
        if (check.verdict === "correct") correctTyped += 1;

        const grade = check.verdict === "correct" ? "good" : "again";
        session.answer(grade);
        await recordReview(db, {
          cardId: card.id,
          deckId: meta.id,
          grade,
          now,
          typed,
          verdict: check.verdict,
          scheduler,
        });
        answersGiven += 1;
      }
      expect(guard).toBeLessThan(500);
    }

    expect(answersGiven).toBeGreaterThan(60);
    expect(correctTyped).toBe(answersGiven);

    const counts = await deckCounts(db, meta.id, new Date(START.getTime() + 7 * DAY_MS));
    expect(counts.fresh).toBe(meta.count - 70);
    expect(counts.learning + counts.review).toBe(70);
    expect(await db.reviews.count()).toBe(answersGiven);
  });
});

describe("обновление колоды поверх выученного", () => {
  it("правка перевода не стоит человеку прогресса", async () => {
    await importDeck(db, deck, { now: START });
    const cards = await loadCards(db, meta.id);
    const target = cards[0] as DeckCard;

    await recordReview(db, {
      cardId: target.id,
      deckId: meta.id,
      grade: "good",
      now: START,
      scheduler,
    });
    const before = (await loadProgress(db, meta.id)).get(target.id);

    // Пересобранная колода: другой перевод у одной карточки, другая версия.
    const edited: DeckFile = {
      meta: { ...meta, version: `${meta.version}-edited`, built_at: new Date(Date.parse(meta.built_at) + 1).toISOString() },
      cards: deck.cards.map((card) =>
        card.id === target.id ? { ...card, translation: "исправленный перевод" } : card,
      ),
    };
    const result = await importDeck(db, edited, { now: START });

    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(result.unchanged).toBe(meta.count - 1);

    const after = (await loadProgress(db, meta.id)).get(target.id);
    expect(after).toEqual(before);

    const stored = await loadCards(db, meta.id);
    expect(stored.find((card) => card.id === target.id)?.translation).toBe(
      "исправленный перевод",
    );
  });
});

describe("резервная копия настоящей базы", () => {
  it("переносит выученное на чистое устройство", async () => {
    await importDeck(db, deck, { now: START });
    const cards = await loadCards(db, meta.id);

    for (const card of cards.slice(0, 20)) {
      await recordReview(db, {
        cardId: card.id,
        deckId: meta.id,
        grade: "good",
        now: START,
        scheduler,
      });
    }

    const backup = JSON.parse(JSON.stringify(await exportBackup(db, { now: START })));

    const fresh = new AppDatabase("integration-restore");
    await fresh.open();
    try {
      await restoreBackup(fresh, backup);
      expect(await loadCards(fresh, meta.id)).toHaveLength(meta.count);
      expect((await loadProgress(fresh, meta.id)).size).toBe(20);
      expect(await fresh.reviews.count()).toBe(20);

      // На новом устройстве очередь дня строится так же, как на старом.
      const queue = buildQueue({
        cards: await loadCards(fresh, meta.id),
        progress: await loadProgress(fresh, meta.id),
        settings: { newPerDay: 10, reviewsPerDay: 60, siblingGap: 4, seed: 1 },
        now: new Date(START.getTime() + DAY_MS),
      });
      expect(queue.counts.fresh).toBe(10);
    } finally {
      fresh.close();
      await fresh.delete();
    }
  });
});
