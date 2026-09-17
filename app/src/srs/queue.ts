/**
 * Очередь дня: что показать сегодня и в каком порядке.
 *
 * Два решения здесь неочевидны и оба продиктованы устройством материала.
 *
 * Первое — **разведение сиблингов**. У слова `decision` полтора десятка
 * кластеров, и подряд они идут не потому, что так задумано, а потому что стоят
 * рядом в словаре. Показанные друг за другом, они мешают вспоминаться: ответ на
 * предыдущую карточку ещё держится в голове и подсказывает следующую.
 *
 * Второе — **новые карточки распределяются между повторениями**, а не идут
 * пачкой в начале или в конце. Пачкой в начале они съедают внимание до
 * повторений, пачкой в конце достаются уже уставшему.
 */

import { isDue } from "./scheduler";
import type { CardProgress, DeckCard } from "./types";

export interface QueueSettings {
  /** Сколько новых карточек вводить за день. */
  newPerDay: number;
  /** Сколько повторений показывать за день. */
  reviewsPerDay: number;
  /**
   * Минимальное число карточек между двумя карточками одного гнезда.
   * Ноль отключает разведение.
   */
  siblingGap: number;
  /** Зерно перемешивания: одна и та же очередь при одинаковом входе. */
  seed?: number;
}

export const DEFAULT_SETTINGS: QueueSettings = {
  newPerDay: 15,
  reviewsPerDay: 120,
  siblingGap: 4,
};

export interface QueueCounts {
  /** Новые, впервые показываемые сегодня. */
  fresh: number;
  /** Недоученные: в процессе освоения, с короткими интервалами. */
  learning: number;
  /** Обычные повторения. */
  review: number;
  total: number;
}

export interface DayQueue {
  cards: DeckCard[];
  counts: QueueCounts;
  /**
   * Сколько повторений просрочено сверх дневного лимита. Ненулевое значение
   * растёт, когда учащийся пропускает дни, и это единственный честный сигнал
   * о надвигающемся завале.
   */
  backlog: number;
}

export type ProgressLookup =
  | Map<string, CardProgress>
  | Record<string, CardProgress>;

function lookup(
  progress: ProgressLookup,
  cardId: string,
): CardProgress | undefined {
  return progress instanceof Map ? progress.get(cardId) : progress[cardId];
}

/**
 * Ключ гнезда: карточки одного заголовочного слова в одном значении.
 *
 * Именно они мешают друг другу: `make a decision` и `take a decision` — про
 * одно и то же слово, и показывать их подряд бессмысленно.
 */
export function familyKey(card: DeckCard): string {
  return `${card.headword.toLowerCase()}|${card.sense ?? ""}`;
}

/** Генератор псевдослучайных чисел с зерном: очередь воспроизводима. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/**
 * Равномерно вплетает одну последовательность в другую.
 *
 * Не чередование один к одному: если повторений сорок, а новых пять, новые
 * встанут примерно через каждые восемь карточек.
 */
export function interleave<T>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base.slice();
  if (base.length === 0) return extra.slice();

  const result: T[] = [];
  const step = (base.length + extra.length) / extra.length;
  let nextExtraAt = step / 2;
  let baseIndex = 0;
  let extraIndex = 0;

  while (baseIndex < base.length || extraIndex < extra.length) {
    const takeExtra =
      extraIndex < extra.length &&
      (baseIndex >= base.length || result.length >= nextExtraAt);
    if (takeExtra) {
      result.push(extra[extraIndex] as T);
      extraIndex += 1;
      nextExtraAt += step;
    } else {
      result.push(base[baseIndex] as T);
      baseIndex += 1;
    }
  }
  return result;
}

/**
 * Раздвигает карточки одного гнезда.
 *
 * Наивный жадный проход — «бери первую подходящую» — оставляет нарушения в
 * хвосте: к концу очереди остаётся одно многочисленное гнездо, и развести его
 * уже нечем. Поэтому среди подходящих выбирается карточка **самого крупного из
 * оставшихся гнёзд**: крупные расходуются равномерно и не копятся к концу.
 *
 * Если подходящих нет вовсе, берётся карточка того гнезда, что встречалось
 * дольше всего назад — нарушение неизбежно, но пусть будет наименьшим. Выбросить
 * карточку из очереди нельзя: пропущенное повторение хуже соседства сиблингов.
 */
export function spaceOutSiblings(cards: DeckCard[], gap: number): DeckCard[] {
  if (gap <= 0) return cards.slice();

  const pending = cards.slice();
  const result: DeckCard[] = [];
  const lastSeen = new Map<string, number>();

  const remaining = new Map<string, number>();
  for (const card of pending) {
    const key = familyKey(card);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  while (pending.length > 0) {
    let pick = -1;
    let bestRemaining = -1;
    let oldest = -1;
    let oldestPick = 0;

    for (let index = 0; index < pending.length; index += 1) {
      const key = familyKey(pending[index] as DeckCard);
      const seen = lastSeen.get(key);
      const distance = seen === undefined ? Number.MAX_SAFE_INTEGER : result.length - seen;

      if (distance > gap) {
        const left = remaining.get(key) ?? 0;
        if (left > bestRemaining) {
          bestRemaining = left;
          pick = index;
        }
      } else if (distance > oldest) {
        oldest = distance;
        oldestPick = index;
      }
    }

    const [card] = pending.splice(pick === -1 ? oldestPick : pick, 1);
    if (card === undefined) break;

    const key = familyKey(card);
    lastSeen.set(key, result.length);
    remaining.set(key, (remaining.get(key) ?? 1) - 1);
    result.push(card);
  }
  return result;
}

export interface BuildQueueInput {
  cards: readonly DeckCard[];
  progress: ProgressLookup;
  settings?: Partial<QueueSettings>;
  now: Date;
}

export function buildQueue({
  cards,
  progress,
  settings,
  now,
}: BuildQueueInput): DayQueue {
  const config: QueueSettings = { ...DEFAULT_SETTINGS, ...settings };
  const random = createRandom(config.seed ?? 1);

  const fresh: DeckCard[] = [];
  const learning: DeckCard[] = [];
  const review: DeckCard[] = [];

  for (const card of cards) {
    const state = lookup(progress, card.id);
    if (state === undefined || state.state === "new") {
      fresh.push(card);
      continue;
    }
    if (!isDue(state, now)) continue;
    if (state.state === "learning" || state.state === "relearning") {
      learning.push(card);
    } else {
      review.push(card);
    }
  }

  // Новые вводятся в порядке изучения — он уже выстроен по частотности и
  // чередует заголовочные слова.
  fresh.sort((a, b) => a.position - b.position);

  // Недоученные карточки лимитом не режутся: они уже начаты, и отложить их
  // значит потерять тот самый короткий интервал, ради которого они в этом
  // состоянии находятся.
  const dueLimited = shuffle(review, random).slice(0, config.reviewsPerDay);
  const backlog = Math.max(0, review.length - config.reviewsPerDay);
  const freshLimited = fresh.slice(0, config.newPerDay);

  const repeats = spaceOutSiblings(
    [...learning, ...dueLimited],
    config.siblingGap,
  );
  const ordered = spaceOutSiblings(
    interleave(repeats, freshLimited),
    config.siblingGap,
  );

  return {
    cards: ordered,
    counts: {
      fresh: freshLimited.length,
      learning: learning.length,
      review: dueLimited.length,
      total: ordered.length,
    },
    backlog,
  };
}
