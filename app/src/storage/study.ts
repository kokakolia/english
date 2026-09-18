/**
 * Чтение прогресса и запись результата повторения.
 *
 * Ключевое требование — **атомарность ответа**. Учащийся нажал оценку, поехала
 * анимация, приложение свернули или закрыли вкладку: к этому моменту и новое
 * состояние карточки, и запись в журнале уже должны быть на диске. Половина
 * записанного хуже, чем ничего: расписание разъедется с журналом, и починить
 * это будет нечем.
 *
 * Поэтому оба обновления идут одной транзакцией, а вызывается она до анимации,
 * а не после.
 */

import { defaultScheduler, isDue, type Grade, type Scheduler } from "../srs";
import type { AnswerVerdict, CardProgress } from "../srs";
import type { AppDatabase, StoredProgress, StoredReview } from "./db";

/** Прогресс по карточкам колоды, готовый к передаче в очередь дня. */
export async function loadProgress(
  db: AppDatabase,
  deckId: string,
): Promise<Map<string, StoredProgress>> {
  const rows = await db.progress.where("deckId").equals(deckId).toArray();
  return new Map(rows.map((row) => [row.cardId, row]));
}

export interface ReviewInput {
  cardId: string;
  deckId: string;
  grade: Grade;
  now?: Date;
  /** Что учащийся набрал, если вводил ответ. */
  typed?: string;
  /** Как система оценила ввод. */
  verdict?: AnswerVerdict;
  durationMs?: number;
  scheduler?: Scheduler;
}

export interface ReviewResult {
  progress: StoredProgress;
  intervalDays: number;
  /** Идентификатор записи журнала — по нему её можно пометить отменённой. */
  reviewId: number;
  /**
   * Прогресс, который был до этой оценки, или `null`, если карточку видели
   * впервые. Вернуть FSRS назад пересчётом нельзя: переход необратим, и
   * единственный способ отменить оценку — положить обратно то, что было.
   */
  previous: StoredProgress | null;
}

/**
 * Применяет оценку: считает новое расписание и фиксирует его вместе с записью
 * журнала.
 */
export async function recordReview(
  db: AppDatabase,
  input: ReviewInput,
): Promise<ReviewResult> {
  const now = input.now ?? new Date();
  const scheduler = input.scheduler ?? defaultScheduler;

  let stored: StoredProgress | undefined;
  let intervalDays = 0;
  let reviewId = 0;
  let before: StoredProgress | null = null;

  await db.transaction("rw", db.progress, db.reviews, async () => {
    before = (await db.progress.get(input.cardId)) ?? null;
    const previous =
      before ??
      ({ ...scheduler.create(input.cardId, now), deckId: input.deckId } as StoredProgress);

    const outcome = scheduler.review(previous, input.grade, now);
    stored = { ...outcome.progress, deckId: input.deckId };
    intervalDays = outcome.intervalDays;

    const entry: StoredReview = {
      cardId: input.cardId,
      reviewedAt: now.toISOString(),
      grade: input.grade,
      stateBefore: previous.state,
      elapsedDays: previous.elapsedDays,
      scheduledDays: previous.scheduledDays,
      ...(input.typed !== undefined ? { typed: input.typed } : {}),
      ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    };

    await db.progress.put(stored);
    reviewId = await db.reviews.add(entry);
  });

  if (stored === undefined) {
    throw new Error("не удалось записать повторение");
  }
  return { progress: stored, intervalDays, reviewId, previous: before };
}

export interface UndoInput {
  cardId: string;
  /** Запись журнала, которую нужно пометить отменённой. */
  reviewId: number;
  /** Прогресс до отменяемой оценки; `null`, если карточку видели впервые. */
  previous: StoredProgress | null;
}

/**
 * Отменяет последнюю оценку по карточке.
 *
 * Прогресс возвращается к сохранённому состоянию, а запись журнала остаётся на
 * месте с пометкой `undone`. Удалять её нельзя: журнал — это то, что было, а
 * не то, что мы хотели бы видеть. Зато пометка позволяет не учитывать промах в
 * статистике и при будущей подгонке параметров FSRS.
 *
 * Обе половины идут одной транзакцией по той же причине, что и запись: прогресс
 * без журнала или журнал без прогресса чинить будет нечем.
 */
export async function undoReview(
  db: AppDatabase,
  input: UndoInput,
): Promise<void> {
  await db.transaction("rw", db.progress, db.reviews, async () => {
    if (input.previous === null) {
      await db.progress.delete(input.cardId);
    } else {
      await db.progress.put(input.previous);
    }
    await db.reviews.update(input.reviewId, { undone: true });
  });
}

export interface DeckCounts {
  /**
   * Сколько повторений просрочено сверх дневного лимита.
   *
   * Считается только если лимит передан: без него понятия «сверх лимита» нет.
   */
  backlog: number;
  /** Карточек в колоде всего. */
  total: number;
  /** Ни разу не показанных. */
  fresh: number;
  /** Ждут повторения прямо сейчас. */
  due: number;
  /** Начатых, но ещё не перешедших в обычные повторения. */
  learning: number;
  /** Дошедших до обычных повторений. */
  review: number;
}

/**
 * Сводка по колоде для экрана начала дня.
 *
 * Считается по индексам, без вычитывания карточек: на девяти тысячах карточек
 * это будет заметно.
 */
export async function deckCounts(
  db: AppDatabase,
  deckId: string,
  now: Date = new Date(),
  reviewsPerDay?: number,
): Promise<DeckCounts> {
  const [total, rows] = await Promise.all([
    db.cards.where("deckId").equals(deckId).count(),
    db.progress.where("deckId").equals(deckId).toArray(),
  ]);

  let due = 0;
  let learning = 0;
  let review = 0;
  for (const row of rows) {
    if (row.state === "learning" || row.state === "relearning") learning += 1;
    if (row.state === "review") review += 1;
    if (row.state !== "new" && isDue(row, now)) due += 1;
  }

  const backlog =
    reviewsPerDay === undefined ? 0 : Math.max(0, due - reviewsPerDay);
  return { total, fresh: total - rows.length, due, learning, review, backlog };
}

/** Журнал повторений по карточке, от старых к новым. */
export async function cardHistory(
  db: AppDatabase,
  cardId: string,
): Promise<StoredReview[]> {
  const rows = await db.reviews.where("cardId").equals(cardId).toArray();
  rows.sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt));
  return rows;
}

/**
 * Сбрасывает прогресс по карточке, не трогая журнал.
 *
 * Журнал остаётся: он описывает то, что действительно происходило, и
 * переписывать историю задним числом нельзя, даже по просьбе пользователя.
 */
export async function resetCard(db: AppDatabase, cardId: string): Promise<void> {
  await db.progress.delete(cardId);
}

/** Текущий прогресс по карточке, если он есть. */
export async function getProgress(
  db: AppDatabase,
  cardId: string,
): Promise<CardProgress | undefined> {
  return db.progress.get(cardId);
}
