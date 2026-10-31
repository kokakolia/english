import { expect, it } from "vitest";
import { nextAvailableAt } from "./availability";
import { nextDayStart } from "./scheduler";
import { makeDeck } from "./testing";
import type { BuildQueueInput } from "./queue";
import type { CardProgress } from "./types";

const NOW = new Date("2026-10-31T10:00:00Z"),
  MINUTE = 60000;
function setup() {
  const cards = makeDeck(2, 2),
    progress = new Map<string, CardProgress>();
  const input: BuildQueueInput = {
    cards,
    progress,
    now: NOW,
    settings: { newPerDay: 0, reviewsPerDay: 1 },
    studiedToday: { fresh: 0, review: 0 },
  };
  function row(
    i: number,
    state: CardProgress["state"],
    due: string,
    extra: Partial<CardProgress> = {},
  ) {
    progress.set(cards[i]!.id, {
      cardId: cards[i]!.id,
      state,
      due,
      lastReview: null,
      stability: 1,
      difficulty: 1,
      elapsedDays: 0,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
      ...extra,
    });
  }
  return { input, row };
}
it("исчерпанный лимит переносит будущие и просроченные review на местную полночь", () => {
  for (const offset of [-5, 5]) {
    const { input, row } = setup();
    row(0, "review", new Date(NOW.getTime() + offset * MINUTE).toISOString());
    input.studiedToday = { fresh: 0, review: 1 };
    expect(nextAvailableAt(input)).toBe(nextDayStart(NOW).toISOString());
  }
});
it("учебные повторы раньше полуночи остаются доступны при исчерпанном лимите", () => {
  const { input, row } = setup(),
    due = new Date(NOW.getTime() + MINUTE).toISOString();
  row(0, "review", due);
  row(1, "relearning", due);
  input.studiedToday = { fresh: 0, review: 1 };
  expect(nextAvailableAt(input)).toBe(due);
});
it("нулевой лимит не обещает доступность обычных повторов завтра", () => {
  const { input, row } = setup();
  input.settings = { newPerDay: 0, reviewsPerDay: 0 };
  row(0, "review", NOW.toISOString());
  row(1, "review", new Date(NOW.getTime() + MINUTE).toISOString());
  expect(nextAvailableAt(input)).toBeNull();
});
it("отложенные до завтра новые и review учитываются, приостановленные исключаются", () => {
  const { input, row } = setup(),
    tomorrow = nextDayStart(NOW).toISOString();
  input.settings = { newPerDay: 1, reviewsPerDay: 1 };
  row(0, "new", NOW.toISOString(), { buriedUntil: tomorrow });
  row(1, "learning", new Date(NOW.getTime() + MINUTE).toISOString(), {
    suspended: true,
  });
  expect(nextAvailableAt(input)).toBe(tomorrow);
  row(0, "review", NOW.toISOString(), { buriedUntil: tomorrow });
  expect(nextAvailableAt(input)).toBe(tomorrow);
});
it("новые снова доступны после сброса их дневного лимита", () => {
  const { input, row } = setup();
  row(1, "new", NOW.toISOString(), { suspended: true });
  input.settings = { newPerDay: 1, reviewsPerDay: 1 };
  input.studiedToday = { fresh: 1, review: 0 };
  expect(nextAvailableAt(input)).toBe(nextDayStart(NOW).toISOString());
});
it("при завале не обещает новые, которые останутся заблокированы и после полуночи", () => {
  const { input, row } = setup();
  input.settings = { newPerDay: 1, reviewsPerDay: 0 };
  row(0, "review", NOW.toISOString()); // вторая карточка новая
  expect(nextAvailableAt(input)).toBeNull();
});
it.each([
  ["2026-03-08T05:30:00Z", "2026-03-09T04:00:00.000Z"],
  ["2026-11-01T04:30:00Z", "2026-11-02T05:00:00.000Z"],
])(
  "сброс лимита учитывает переход на летнее/зимнее время: %s",
  (now, expected) => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const { input } = setup();
      input.now = new Date(now);
      input.settings = { newPerDay: 1, reviewsPerDay: 1 };
      input.studiedToday = { fresh: 1, review: 0 };
      expect(nextAvailableAt(input)).toBe(expected);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  },
);
