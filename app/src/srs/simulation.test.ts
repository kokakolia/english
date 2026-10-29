/**
 * Симуляция года повторений.
 *
 * Это главная проверка ядра. Ошибка в расписании не видна на отдельном вызове:
 * карточки будут показываться, просто не в те дни, и обнаружится это через
 * месяцы реального использования. Поэтому здесь виртуальный учащийся год
 * занимается по расписанию, а тест смотрит на то, что нельзя проверить
 * поштучно: не растёт ли завал, не схлопываются ли интервалы, держится ли
 * доля успешных вспоминаний.
 */

import { describe, expect, it } from "vitest";

import { buildQueue, familyKey } from "./queue";
import { createScheduler } from "./scheduler";
import { createSession } from "./session";
import { makeDeck } from "./testing";
import type { CardProgress, DeckCard, Grade } from "./types";

const scheduler = createScheduler({ enableFuzz: false });
const START = new Date("2026-01-01T09:00:00Z");
const DAY_MS = 86_400_000;

/**
 * Вероятность вспомнить: кривая забывания FSRS.
 *
 * При прошедшем времени, равном стабильности, вероятность равна целевым 90%;
 * дальше падает. Множитель на карточку делает часть материала стабильно
 * трудной — иначе симуляция получилась бы неправдоподобно ровной.
 */
function recallChance(
  progress: CardProgress,
  now: Date,
  hardness: number,
): number {
  const elapsedDays = progress.lastReview
    ? (now.getTime() - new Date(progress.lastReview).getTime()) / DAY_MS
    : 0;
  const stability = Math.max(progress.stability, 0.1) * hardness;
  return Math.exp(Math.log(0.9) * (elapsedDays / stability));
}

function gradeFor(recalled: boolean, roll: number): Grade {
  if (!recalled) return "again";
  if (roll < 0.15) return "hard";
  if (roll > 0.85) return "easy";
  return "good";
}

interface DayStats {
  day: number;
  shown: number;
  backlog: number;
  again: number;
  reviewAnswers: number;
}

interface SimulationResult {
  days: DayStats[];
  progress: Map<string, CardProgress>;
  introduced: Set<string>;
  /** Нарушения отступа в дни, когда развести было можно. */
  avoidableViolations: number;
  /** Нарушения в дни, когда гнездо физически не помещалось в очередь. */
  unavoidableViolations: number;
  shownTotal: number;
  duplicatesInQueue: number;
}

/**
 * Можно ли вообще развести гнёзда в очереди такой длины.
 *
 * Самое крупное гнездо задаёт каркас: между его карточками должно уместиться по
 * `gap` чужих, то есть оно занимает `(k - 1) * (gap + 1)` позиций плюс хвост. В
 * хвосте помещаются все гнёзда такого же размера — по одному на позицию.
 * Получается точное условие, а не оценка сверху.
 *
 * В очереди из двадцати карточек с отступом четыре помещается не больше
 * четырёх карточек одного гнезда — при двенадцати карточках на гнездо в колоде
 * короткие дни неизбежно дают соседство.
 */
function spacingIsPossible(cards: readonly DeckCard[], gap: number): boolean {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const key = familyKey(card);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sizes = [...counts.values()];
  const biggest = Math.max(0, ...sizes);
  const tied = sizes.filter((size) => size === biggest).length;
  return (biggest - 1) * (gap + 1) + tied <= cards.length;
}

function simulate(
  cards: DeckCard[],
  options: {
    days: number;
    newPerDay: number;
    reviewsPerDay: number;
    siblingGap: number;
    skipDays?: Set<number>;
    seed?: number;
  },
): SimulationResult {
  const progress = new Map<string, CardProgress>();
  const introduced = new Set<string>();
  const days: DayStats[] = [];
  let avoidableViolations = 0;
  let unavoidableViolations = 0;
  let shownTotal = 0;
  let duplicatesInQueue = 0;

  // Собственный генератор: симуляция должна быть воспроизводимой.
  let seedState = (options.seed ?? 20260101) >>> 0;
  const roll = () => {
    seedState = (seedState * 1664525 + 1013904223) >>> 0;
    return seedState / 4294967296;
  };

  // Постоянная «трудность» карточки: часть материала даётся хуже.
  const hardness = new Map(cards.map((card) => [card.id, 0.6 + roll() * 0.8]));

  for (let day = 0; day < options.days; day += 1) {
    const now = new Date(START.getTime() + day * DAY_MS);
    const queue = buildQueue({
      cards,
      progress,
      settings: {
        newPerDay: options.newPerDay,
        reviewsPerDay: options.reviewsPerDay,
        siblingGap: options.siblingGap,
        seed: day + 1,
      },
      now,
    });

    const ids = queue.cards.map((card) => card.id);
    duplicatesInQueue += ids.length - new Set(ids).size;

    const lastSeen = new Map<string, number>();
    let violations = 0;
    queue.cards.forEach((card, index) => {
      const previous = lastSeen.get(familyKey(card));
      if (previous !== undefined && index - previous <= options.siblingGap) {
        violations += 1;
      }
      lastSeen.set(familyKey(card), index);
    });
    shownTotal += queue.cards.length;
    if (spacingIsPossible(queue.cards, options.siblingGap)) {
      avoidableViolations += violations;
    } else {
      unavoidableViolations += violations;
    }

    const stats: DayStats = {
      day,
      shown: queue.cards.length,
      backlog: queue.backlog,
      again: 0,
      reviewAnswers: 0,
    };

    if (options.skipDays?.has(day)) {
      days.push({ ...stats, shown: 0 });
      continue;
    }

    const session = createSession(queue.cards, { againGap: 3 });
    let guard = 0;
    while (!session.isFinished() && guard < 5000) {
      guard += 1;
      const card = session.current();
      if (card === null) break;

      const current = progress.get(card.id) ?? scheduler.create(card.id, now);
      introduced.add(card.id);

      const wasReview = current.state === "review";
      const chance = recallChance(current, now, hardness.get(card.id) ?? 1);
      const recalled = roll() < chance;
      const grade = gradeFor(recalled, roll());

      if (wasReview) {
        stats.reviewAnswers += 1;
        if (grade === "again") stats.again += 1;
      }

      session.answer(grade);
      progress.set(card.id, scheduler.review(current, grade, now).progress);
    }
    expect(guard).toBeLessThan(5000);

    days.push(stats);
  }

  return {
    days,
    progress,
    introduced,
    avoidableViolations,
    unavoidableViolations,
    shownTotal,
    duplicatesInQueue,
  };
}

describe("год повторений", () => {
  // Гнёзд примерно столько же, сколько в настоящей колоде: около дюжины
  // карточек на заголовочное слово.
  const cards = makeDeck(300, 25);
  const result = simulate(cards, {
    days: 365,
    newPerDay: 15,
    reviewsPerDay: 120,
    siblingGap: 4,
  });

  it("вводит весь материал", () => {
    expect(result.introduced.size).toBe(cards.length);
  });

  it("не копит завал при ежедневных занятиях", () => {
    const worst = Math.max(...result.days.map((day) => day.backlog));
    expect(worst).toBe(0);
  });

  it("не показывает одну карточку дважды за день", () => {
    expect(result.duplicatesInQueue).toBe(0);
  });

  it("разводит сиблингов везде, где это возможно", () => {
    expect(result.avoidableViolations).toBe(0);
  });

  it("там, где развести нельзя, соседств всё равно единицы", () => {
    // В короткой очереди крупное гнездо не помещается ни при каком порядке.
    // Важно, что таких случаев мало: иначе разведение не работало бы.
    const share = result.unavoidableViolations / result.shownTotal;
    expect(share).toBeLessThan(0.02);
  });

  it("нагрузка не разрастается к концу года", () => {
    // После ввода всего материала дневная порция должна убывать: интервалы
    // растут, значит повторений в день становится меньше.
    const firstMonth = result.days.slice(30, 60);
    const lastMonth = result.days.slice(-30);
    const average = (list: DayStats[]) =>
      list.reduce((sum, day) => sum + day.shown, 0) / list.length;
    expect(average(lastMonth)).toBeLessThan(average(firstMonth));
  });

  it("доля успешных вспоминаний близка к заданной", () => {
    const answers = result.days.reduce(
      (sum, day) => sum + day.reviewAnswers,
      0,
    );
    const failures = result.days.reduce((sum, day) => sum + day.again, 0);
    const retention = 1 - failures / answers;

    expect(answers).toBeGreaterThan(1000);
    // Планировщик настроен на 0.9; отклонение в обе стороны означало бы, что
    // интервалы систематически коротки или, наоборот, велики.
    expect(retention).toBeGreaterThan(0.8);
    expect(retention).toBeLessThan(0.97);
  });

  it("интервалы растут", () => {
    const intervals = [...result.progress.values()].map((p) => p.scheduledDays);
    const average =
      intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    expect(average).toBeGreaterThan(20);
  });

  it("почти весь материал доходит до обычных повторений", () => {
    const states = [...result.progress.values()];
    const inReview = states.filter((p) => p.state === "review").length;
    expect(inReview / states.length).toBeGreaterThan(0.8);
  });
});

describe("пропуск занятий", () => {
  const cards = makeDeck(200, 10);
  const skipDays = new Set(
    Array.from({ length: 30 }, (_, index) => 60 + index),
  );
  const result = simulate(cards, {
    days: 200,
    newPerDay: 10,
    reviewsPerDay: 40,
    siblingGap: 3,
    skipDays,
  });

  it("завал появляется и виден", () => {
    // Молчаливое отбрасывание просроченных карточек скрыло бы от учащегося
    // настоящий объём долга, поэтому очередь сообщает о нём отдельно.
    const duringBreak = result.days.slice(60, 90);
    expect(Math.max(...duringBreak.map((day) => day.backlog))).toBeGreaterThan(
      0,
    );
  });

  it("завал рассасывается после возвращения", () => {
    const afterBreak = result.days.slice(120);
    expect(Math.max(...afterBreak.map((day) => day.backlog))).toBe(0);
  });

  it("материал не теряется", () => {
    expect(result.introduced.size).toBe(cards.length);
  });
});
