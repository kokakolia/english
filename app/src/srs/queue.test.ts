import { describe, expect, it } from "vitest";

import {
  buildQueue,
  createRandom,
  familyKey,
  interleave,
  spaceOutSiblings,
} from "./queue";
import { createScheduler } from "./scheduler";
import { makeCard, makeDeck } from "./testing";
import type { CardProgress } from "./types";

const scheduler = createScheduler({ enableFuzz: false });
const DAY = new Date("2026-03-01T09:00:00Z");

function progressMap(entries: CardProgress[]): Map<string, CardProgress> {
  return new Map(entries.map((entry) => [entry.cardId, entry]));
}

/** Карточка, срок которой наступил: изучена и отложена в прошлое. */
function dueProgress(cardId: string, daysAgo: number): CardProgress {
  const start = new Date(DAY.getTime() - daysAgo * 86_400_000);
  const first = scheduler.review(
    scheduler.create(cardId, start),
    "good",
    start,
  );
  return { ...first.progress, due: start.toISOString(), state: "review" };
}

describe("вплетение", () => {
  it("распределяет добавку равномерно, а не пачкой", () => {
    const base = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const extra = ["n1", "n2"];
    const mixed = interleave(base, extra);

    expect(mixed).toHaveLength(8);
    expect(mixed.filter((item) => item.startsWith("n"))).toEqual(extra);
    // Новые не должны оказаться ни в самом начале, ни оба в конце.
    expect(mixed[0]).toBe("r1");
    const positions = extra.map((item) => mixed.indexOf(item));
    expect(positions[1]! - positions[0]!).toBeGreaterThan(2);
  });

  it("выдерживает пустые входы", () => {
    expect(interleave([], ["a"])).toEqual(["a"]);
    expect(interleave(["a"], [])).toEqual(["a"]);
  });
});

describe("разведение сиблингов", () => {
  it("не ставит карточки одного гнезда рядом", () => {
    const cards = makeDeck(24, 4);
    const spaced = spaceOutSiblings(cards, 3);

    const lastSeen = new Map<string, number>();
    let violations = 0;
    spaced.forEach((card, index) => {
      const previous = lastSeen.get(familyKey(card));
      if (previous !== undefined && index - previous <= 3) violations += 1;
      lastSeen.set(familyKey(card), index);
    });
    expect(violations).toBe(0);
  });

  it("ничего не теряет и не дублирует", () => {
    const cards = makeDeck(24, 4);
    const spaced = spaceOutSiblings(cards, 3);
    expect(new Set(spaced.map((card) => card.id)).size).toBe(cards.length);
  });

  it("не зацикливается, когда развести нечем", () => {
    // Все карточки одного гнезда: требование невыполнимо, но очередь всё равно
    // должна получиться — лучше сиблинги рядом, чем потерянные карточки.
    const cards = makeDeck(6, 1);
    const spaced = spaceOutSiblings(cards, 5);
    expect(spaced).toHaveLength(6);
  });

  it("при нулевом отступе не трогает порядок", () => {
    const cards = makeDeck(5, 1);
    expect(spaceOutSiblings(cards, 0).map((c) => c.id)).toEqual(
      cards.map((c) => c.id),
    );
  });
});

describe("очередь дня", () => {
  it("отбирает самые старые сроки раньше новых и возобновляет новые после разгрузки", () => {
    const reviews = makeDeck(3, 3);
    const fresh = makeCard({ id: "new-card", position: 100 });
    const entries = reviews.map((card, i) => dueProgress(card.id, i + 1));
    const input = {
      cards: [...reviews, fresh],
      progress: progressMap(entries),
      now: DAY,
    };
    const limited = buildQueue({
      ...input,
      settings: { reviewsPerDay: 1, newPerDay: 5, siblingGap: 0 },
    });
    expect(limited.cards.map((card) => card.id)).toEqual([reviews[2]!.id]);
    expect(limited.counts.fresh).toBe(0);
    expect(limited.backlog).toBe(2);
    const cleared = buildQueue({
      ...input,
      settings: { reviewsPerDay: 3, newPerDay: 5, siblingGap: 0 },
    });
    expect(cleared.counts.fresh).toBe(1);
    const used = buildQueue({
      ...input,
      studiedToday: { fresh: 0, review: 3 },
      settings: { reviewsPerDay: 3, newPerDay: 5 },
    });
    expect(used.counts.fresh).toBe(0);
  });
  it("соблюдает лимит новых карточек", () => {
    const cards = makeDeck(100, 10);
    const queue = buildQueue({
      cards,
      progress: new Map(),
      settings: { newPerDay: 7, siblingGap: 0 },
      now: DAY,
    });

    expect(queue.counts.fresh).toBe(7);
    expect(queue.cards).toHaveLength(7);
  });

  it("вводит новые карточки в порядке изучения", () => {
    const cards = makeDeck(50, 5);
    const queue = buildQueue({
      cards,
      progress: new Map(),
      settings: { newPerDay: 5, siblingGap: 0 },
      now: DAY,
    });
    expect(queue.cards.map((card) => card.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("соблюдает лимит повторений и показывает остаток как завал", () => {
    const cards = makeDeck(40, 8);
    const progress = progressMap(cards.map((card) => dueProgress(card.id, 3)));

    const queue = buildQueue({
      cards,
      progress,
      settings: { newPerDay: 0, reviewsPerDay: 10, siblingGap: 0 },
      now: DAY,
    });

    expect(queue.counts.review).toBe(10);
    expect(queue.backlog).toBe(30);
  });

  it("не показывает карточки, срок которых не наступил", () => {
    const cards = makeDeck(5, 5);
    const future = cards.map((card) => ({
      ...dueProgress(card.id, 0),
      due: new Date(DAY.getTime() + 5 * 86_400_000).toISOString(),
    }));

    const queue = buildQueue({
      cards,
      progress: progressMap(future),
      settings: { newPerDay: 0, siblingGap: 0 },
      now: DAY,
    });
    expect(queue.cards).toHaveLength(0);
    expect(queue.backlog).toBe(0);
  });

  it("недоученные карточки лимитом не режутся", () => {
    // Они уже начаты, и откладывать их значит потерять короткий интервал,
    // ради которого они в этом состоянии находятся.
    const cards = makeDeck(12, 6);
    const learning = cards.map((card) => ({
      ...dueProgress(card.id, 1),
      state: "learning" as const,
    }));

    const queue = buildQueue({
      cards,
      progress: progressMap(learning),
      settings: { newPerDay: 0, reviewsPerDay: 3, siblingGap: 0 },
      now: DAY,
    });
    expect(queue.counts.learning).toBe(12);
    expect(queue.cards).toHaveLength(12);
  });

  it("даёт одну и ту же очередь при одном зерне", () => {
    const cards = makeDeck(30, 6);
    const progress = progressMap(cards.map((card) => dueProgress(card.id, 2)));
    const settings = { newPerDay: 0, reviewsPerDay: 20, seed: 42 };

    const first = buildQueue({ cards, progress, settings, now: DAY });
    const second = buildQueue({ cards, progress, settings, now: DAY });
    expect(first.cards.map((c) => c.id)).toEqual(second.cards.map((c) => c.id));

    const other = buildQueue({
      cards,
      progress,
      settings: { ...settings, seed: 7 },
      now: DAY,
    });
    expect(other.cards.map((c) => c.id)).not.toEqual(
      first.cards.map((c) => c.id),
    );
  });

  it("смешивает новые с повторениями", () => {
    const reviewCards = makeDeck(20, 10);
    const freshCards = Array.from({ length: 4 }, (_, index) =>
      makeCard({
        id: `fresh-${index}`,
        headword: `fresh${index}`,
        position: 900 + index,
      }),
    );
    const progress = progressMap(
      reviewCards.map((card) => dueProgress(card.id, 2)),
    );

    const queue = buildQueue({
      cards: [...reviewCards, ...freshCards],
      progress,
      settings: { newPerDay: 4, reviewsPerDay: 20, siblingGap: 0, seed: 3 },
      now: DAY,
    });

    const freshPositions = queue.cards
      .map((card, index) => (card.id.startsWith("fresh") ? index : -1))
      .filter((index) => index >= 0);

    expect(freshPositions).toHaveLength(4);
    // Не пачкой в начале и не пачкой в конце.
    expect(
      Math.max(...freshPositions) - Math.min(...freshPositions),
    ).toBeGreaterThan(8);
  });

  it("принимает прогресс и объектом, и картой", () => {
    const cards = makeDeck(3, 3);
    const entries = cards.map((card) => dueProgress(card.id, 1));
    const asRecord = Object.fromEntries(entries.map((e) => [e.cardId, e]));

    const viaMap = buildQueue({
      cards,
      progress: progressMap(entries),
      settings: { newPerDay: 0, siblingGap: 0 },
      now: DAY,
    });
    const viaRecord = buildQueue({
      cards,
      progress: asRecord,
      settings: { newPerDay: 0, siblingGap: 0 },
      now: DAY,
    });
    expect(viaRecord.counts).toEqual(viaMap.counts);
  });
});

describe("генератор случайных чисел", () => {
  it("воспроизводим и лежит в единичном отрезке", () => {
    const first = Array.from({ length: 5 }, createRandom(11));
    const again = createRandom(11);
    expect(Array.from({ length: 5 }, again)).toEqual(
      Array.from({ length: 5 }, createRandom(11)),
    );
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
