import { describe, expect, it } from "vitest";

import { createScheduler, isDue } from "./scheduler";
import type { CardProgress } from "./types";
import { validSchedule } from "./validation";

const scheduler = createScheduler({ enableFuzz: false });
const START = new Date("2026-01-01T08:00:00Z");

function daysLater(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

describe("создание прогресса", () => {
  it("новая карточка не изучена и должна быть показана сразу", () => {
    const progress = scheduler.create("c_1", START);
    expect(progress).toMatchObject({
      cardId: "c_1",
      state: "new",
      reps: 0,
      lapses: 0,
    });
    expect(isDue(progress, START)).toBe(true);
  });

  it("формат сериализуем без потерь", () => {
    // Прогресс уходит в IndexedDB и в файл экспорта, поэтому должен пережить
    // круг через JSON без догадок о часовом поясе и без объектов Date.
    const progress = scheduler.create("c_1", START);
    const restored: CardProgress = JSON.parse(JSON.stringify(progress));
    expect(restored).toEqual(progress);
    expect(typeof restored.due).toBe("string");
  });
});

describe("применение оценки", () => {
  it("состояние review с нулевыми параметрами не попадает в FSRS", () => {
    const invalid: CardProgress = {
      ...scheduler.create("c_1", START),
      state: "review",
      reps: 1,
      lastReview: START.toISOString(),
    };
    expect(validSchedule(invalid)).toBe(false);
    expect(() => scheduler.review(invalid, "again", START)).toThrow(
      "Некорректное состояние",
    );
    expect(() => scheduler.preview(invalid, START)).toThrow(
      "Некорректное состояние",
    );
  });
  it("переводит новую карточку в изучение", () => {
    const { progress } = scheduler.review(
      scheduler.create("c_1", START),
      "good",
      START,
    );
    expect(progress.state).toBe("learning");
    expect(progress.reps).toBe(1);
    expect(progress.lastReview).toBe(START.toISOString());
  });

  it("чем выше оценка, тем дальше следующий показ", () => {
    const base = scheduler.create("c_1", START);
    const preview = scheduler.preview(base, START);

    expect(preview.again.intervalDays).toBeLessThanOrEqual(
      preview.hard.intervalDays,
    );
    expect(preview.hard.intervalDays).toBeLessThanOrEqual(
      preview.good.intervalDays,
    );
    expect(preview.good.intervalDays).toBeLessThan(preview.easy.intervalDays);
  });

  it("предпросмотр не меняет прогресс", () => {
    const base = scheduler.create("c_1", START);
    const snapshot = JSON.stringify(base);
    scheduler.preview(base, START);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("интервалы растут при успешных повторениях", () => {
    let progress = scheduler.create("c_1", START);
    let now = START;
    const intervals: number[] = [];

    for (let step = 0; step < 6; step += 1) {
      const outcome = scheduler.review(progress, "good", now);
      progress = outcome.progress;
      intervals.push(outcome.intervalDays);
      now = new Date(progress.due);
    }

    const last = intervals[intervals.length - 1] ?? 0;
    const first = intervals[0] ?? 0;
    expect(last).toBeGreaterThan(first);
    expect(progress.state).toBe("review");
  });

  it("забывание откатывает карточку и считается ошибкой", () => {
    let progress = scheduler.create("c_1", START);
    let now = START;
    for (let step = 0; step < 4; step += 1) {
      progress = scheduler.review(progress, "good", now).progress;
      now = new Date(progress.due);
    }
    const before = progress;

    const after = scheduler.review(before, "again", daysLater(now, 1)).progress;
    expect(after.lapses).toBe(before.lapses + 1);
    expect(after.state).toBe("relearning");
    expect(after.stability).toBeLessThan(before.stability);
  });
});

describe("настройки планировщика", () => {
  it("более высокое требование к запоминанию укорачивает интервалы", () => {
    const relaxed = createScheduler({
      enableFuzz: false,
      requestRetention: 0.8,
    });
    const strict = createScheduler({
      enableFuzz: false,
      requestRetention: 0.97,
    });

    const grow = (engine: ReturnType<typeof createScheduler>) => {
      let progress = engine.create("c_1", START);
      let now = START;
      for (let step = 0; step < 5; step += 1) {
        const outcome = engine.review(progress, "good", now);
        progress = outcome.progress;
        now = new Date(progress.due);
      }
      return progress;
    };

    const relaxedDue = new Date(grow(relaxed).due).getTime();
    const strictDue = new Date(grow(strict).due).getTime();
    expect(strictDue).toBeLessThan(relaxedDue);
  });

  it("верхняя граница интервала ограничивает рост", () => {
    // Библиотека применяет границу приблизительно: при заданных 30 днях
    // интервал устаканивается на 32. Проверяем то, ради чего настройка нужна —
    // что рост останавливается, — а не точное число, которое зависит от
    // внутренностей ts-fsrs и может измениться при её обновлении.
    const grow = (engine: ReturnType<typeof createScheduler>) => {
      let progress = engine.create("c_1", START);
      let now = START;
      for (let step = 0; step < 20; step += 1) {
        progress = engine.review(progress, "easy", now).progress;
        now = new Date(progress.due);
      }
      return progress.scheduledDays;
    };

    const capped = grow(
      createScheduler({ enableFuzz: false, maximumInterval: 30 }),
    );
    const uncapped = grow(createScheduler({ enableFuzz: false }));

    expect(capped).toBeLessThan(40);
    expect(uncapped).toBeGreaterThan(capped * 10);
  });
});
