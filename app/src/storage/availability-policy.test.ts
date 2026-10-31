import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "./db";
import { importDeck } from "./decks";
import { deckCounts, recordReview, buryCard } from "./study";
import { updateStudySettings } from "./settings";
import { createScheduler, nextDayStart } from "../srs";
import { makeDeck } from "../srs/testing";

const NOW = new Date("2026-10-31T10:00:00Z"),
  scheduler = createScheduler({ enableFuzz: false });
const opened: AppDatabase[] = [];
async function setup() {
  const db = new AppDatabase(`availability-${crypto.randomUUID()}`);
  opened.push(db);
  await db.open();
  const cards = makeDeck(2, 2);
  await importDeck(db, {
    meta: {
      id: "audit",
      name: "Audit",
      version: "v1",
      language: "en",
      card_type: "cloze",
      built_at: NOW.toISOString(),
      count: 2,
      chunks: ["cards-000.json"],
    },
    cards,
  });
  return { db, cards };
}
afterEach(async () => {
  for (const db of opened) {
    db.close();
    await db.delete();
  }
  opened.length = 0;
});

it("обещанное время после исчерпания лимита действительно открывает повторение", async () => {
  const { db, cards } = await setup();
  await updateStudySettings(db, { newPerDay: 0, reviewsPerDay: 1 });
  const past = new Date(NOW.getTime() - 3 * 86400000),
    future = new Date(NOW.getTime() + 300000);
  for (let i = 0; i < 2; i++) {
    const row = scheduler.review(
      scheduler.create(cards[i]!.id, past),
      "easy",
      past,
    ).progress;
    await db.progress.put({
      ...row,
      deckId: "audit",
      due: i === 0 ? past.toISOString() : future.toISOString(),
    });
  }
  await recordReview(db, {
    deckId: "audit",
    cardId: cards[0]!.id,
    grade: "easy",
    now: NOW,
    scheduler,
  });
  const before = await deckCounts(db, "audit", NOW, 1, 0);
  expect(before.nextReviewAt).toBe(nextDayStart(NOW).toISOString());
  expect(before.reviewLimitReached).toBe(true);
  expect((await deckCounts(db, "audit", future, 1, 0)).due).toBe(0);
  const available = await deckCounts(
    db,
    "audit",
    new Date(before.nextReviewAt!),
    1,
    0,
  );
  expect(available.due).toBe(1);
  expect(available.reviewLimitReached).toBe(false);
});

it("нулевые лимиты не объявляются временно исчерпанными", async () => {
  const { db } = await setup();
  await updateStudySettings(db, { newPerDay: 0, reviewsPerDay: 0 });
  const counts = await deckCounts(db, "audit", NOW, 0, 0);
  expect(counts).toMatchObject({
    nextReviewAt: null,
    reviewLimitReached: false,
    newLimitReached: false,
    newCardsDisabled: true,
    reviewsDisabled: true,
  });
});

it("отложенные новые карточки появляются в обещанное время", async () => {
  const { db, cards } = await setup();
  for (const card of cards)
    await buryCard(db, {
      deckId: "audit",
      cardId: card.id,
      now: NOW,
      scheduler,
    });
  const before = await deckCounts(db, "audit", NOW, 1, 1);
  expect(before.fresh).toBe(0);
  expect(before.nextReviewAt).toBe(nextDayStart(NOW).toISOString());
  expect(
    (await deckCounts(db, "audit", new Date(before.nextReviewAt!), 1, 1)).fresh,
  ).toBe(1);
});
