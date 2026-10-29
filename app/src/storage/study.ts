import { updateSafety } from "../app/update-safety";
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

import {
  defaultScheduler,
  isHidden,
  nextDayStart,
  type Grade,
  type Scheduler,
} from "../srs";
import type { AnswerVerdict, CardProgress } from "../srs";
import type { AppDatabase, StoredProgress, StoredReview } from "./db";
import { markChanged } from "./changes";
import { buildQueue } from "../srs";
import { loadCards } from "./decks";
import { getStudySettings } from "./settings";
import { assertAvailableOwners } from "./ownership";

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
  const release = updateSafety.begin();
  try {
    const now = input.now ?? new Date();
    const scheduler = input.scheduler ?? defaultScheduler;

    let stored: StoredProgress | undefined;
    let intervalDays = 0;
    let reviewId = 0;
    let before: StoredProgress | null = null;

    await db.transaction("rw", [db.progress, db.reviews, db.changes, db.cards], async () => {
      await assertAvailableOwners(db, [{ cardId: input.cardId, deckId: input.deckId }]);
      before = (await db.progress.get(input.cardId)) ?? null;
      const previous =
        before ??
        ({ ...scheduler.create(input.cardId, now), deckId: input.deckId } as StoredProgress);

      const outcome = scheduler.review(previous, input.grade, now);
      stored = { ...outcome.progress, deckId: input.deckId };
      intervalDays = outcome.intervalDays;

      const entry: StoredReview = {
        eventId: crypto.randomUUID(),
        cardId: input.cardId,
        reviewedAt: now.toISOString(),
        grade: input.grade,
        stateBefore: previous.state,
        elapsedDays: outcome.progress.elapsedDays,
        scheduledDays: previous.scheduledDays,
        ...(input.typed !== undefined ? { typed: input.typed } : {}),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      };

      await db.progress.put(stored);
      await markChanged(db, input.cardId, input.deckId, now);
      reviewId = await db.reviews.add(entry);
    });

    if (stored === undefined) {
      throw new Error("не удалось записать повторение");
    }
    return { progress: stored, intervalDays, reviewId, previous: before };
  } finally { release(); }
}

export interface UndoInput {
  now?: Date;
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
  const release = updateSafety.begin();
  try {
    await db.transaction("rw", [db.progress, db.reviews, db.changes, db.cards], async () => {
      const current = await db.progress.get(input.cardId);
      const change = await db.changes.get(input.cardId);
      const deckId = input.previous?.deckId ?? current?.deckId ?? change?.deckId;
      if (deckId === undefined) throw new Error("колода отменяемой карточки неизвестна");
      await assertAvailableOwners(db, [{ cardId: input.cardId, deckId }]);
      await markChanged(db, input.cardId, deckId, input.now ?? new Date());
      if (input.previous === null) {
        await db.progress.delete(input.cardId);
      } else {
        await db.progress.put(input.previous);
      }
      await db.reviews.update(input.reviewId, { undone: true });
    });
  } finally { release(); }
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

/** Сколько уникальных карточек уже израсходовало лимит местного дня. */
export async function studiedToday(db: AppDatabase, deckId: string, now: Date): Promise<{ fresh: number; review: number }> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const rows = await db.reviews.where("reviewedAt").between(start.toISOString(), now.toISOString(), true, true).toArray();
  const ids = new Set((await db.cards.where("deckId").equals(deckId).primaryKeys()) as string[]);
  const fresh = new Set<string>();
  const review = new Set<string>();
  for (const row of rows) {
    if (row.undone || !ids.has(row.cardId)) continue;
    if (row.stateBefore === "new") fresh.add(row.cardId);
    if (row.stateBefore === "review") review.add(row.cardId);
  }
  return { fresh: fresh.size, review: review.size };
}

/** Сводка и очередь используют одинаковый отбор карточек и остаток лимита. */
export async function deckCounts(
  db: AppDatabase,
  deckId: string,
  now: Date = new Date(),
  reviewsPerDay?: number,
  newPerDay?: number,
): Promise<DeckCounts> {
  const [cards, progress, used, settings] = await Promise.all([
    loadCards(db, deckId), loadProgress(db, deckId), studiedToday(db, deckId, now), getStudySettings(db),
  ]);
  const queue = buildQueue({ cards, progress, now, studiedToday: used, settings: {
    ...settings,
    newPerDay: newPerDay ?? cards.length + used.fresh,
    reviewsPerDay: reviewsPerDay ?? cards.length + used.review,
  } });
  let learning = 0;
  let review = 0;
  for (const card of cards) {
    const row = progress.get(card.id);
    if (!row || isHidden(row, now)) continue;
    if (row.state === "learning" || row.state === "relearning") learning++;
    if (row.state === "review") review++;
  }
  return { total: cards.length, fresh: queue.counts.fresh, due: queue.counts.learning + queue.counts.review,
    learning, review, backlog: reviewsPerDay === undefined ? 0 : queue.backlog };
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

/** Что было с карточкой до действия — чтобы действие можно было отменить. */
export type PreviousProgress = StoredProgress | null;

/**
 * Сбрасывает прогресс по карточке, не трогая журнал.
 *
 * Журнал остаётся: он описывает то, что действительно происходило, и
 * переписывать историю задним числом нельзя, даже по просьбе пользователя.
 *
 * Возвращает прежнюю запись — по ней сброс отменяется.
 */
export async function resetCard(
  db: AppDatabase,
  cardId: string,
  now: Date = new Date(),
): Promise<PreviousProgress> {
  const release = updateSafety.begin();
  try {
    let before: PreviousProgress = null;
    await db.transaction("rw", db.progress, db.changes, db.cards, async () => {
      before = (await db.progress.get(cardId)) ?? null;
      const deckId = before?.deckId ?? (await db.cards.get(cardId))?.deckId ?? (await db.changes.get(cardId))?.deckId;
      if (deckId === undefined) throw new Error("карточка не найдена");
      await assertAvailableOwners(db, [{ cardId, deckId }]);
      await markChanged(db, cardId, deckId, now);
      await db.progress.delete(cardId);
    });
    return before;
  } finally { release(); }
}

export interface HideInput {
  cardId: string;
  deckId: string;
  now?: Date;
  scheduler?: Scheduler;
}

/**
 * Убирает карточку из оборота до отмены.
 *
 * Если карточку ещё ни разу не показывали, запись прогресса заводится в
 * состоянии «новая»: приостановка не должна засчитывать её как начатую, иначе
 * возврат в оборот выдал бы карточку с выдуманным расписанием.
 */
export async function suspendCard(
  db: AppDatabase,
  input: HideInput,
): Promise<PreviousProgress> {
  return writeFlag(db, input, (row) => ({ ...row, suspended: true }));
}

/** Возвращает приостановленную карточку в оборот. */
export async function unsuspendCard(
  db: AppDatabase,
  input: HideInput,
): Promise<PreviousProgress> {
  return writeFlag(db, input, (row) => ({ ...row, suspended: false }));
}

/** Прячет карточку до начала следующих суток. */
export async function buryCard(
  db: AppDatabase,
  input: HideInput,
): Promise<PreviousProgress> {
  const until = nextDayStart(input.now ?? new Date()).toISOString();
  return writeFlag(db, input, (row) => ({ ...row, buriedUntil: until }));
}

async function writeFlag(
  db: AppDatabase,
  input: HideInput,
  change: (row: StoredProgress) => StoredProgress,
): Promise<PreviousProgress> {
  const release = updateSafety.begin();
  try {
    const now = input.now ?? new Date();
    const scheduler = input.scheduler ?? defaultScheduler;
    let before: PreviousProgress = null;

    await db.transaction("rw", [db.progress, db.changes, db.cards], async () => {
      await assertAvailableOwners(db, [{ cardId: input.cardId, deckId: input.deckId }]);
      before = (await db.progress.get(input.cardId)) ?? null;
      await markChanged(db, input.cardId, input.deckId, now);
      const base: StoredProgress =
        before ??
        ({ ...scheduler.create(input.cardId, now), deckId: input.deckId } as StoredProgress);
      await db.progress.put(change(base));
    });

    return before;
  } finally { release(); }
}

/**
 * Возвращает запись прогресса на место — или удаляет её, если записи не было.
 *
 * Общая отмена для всех действий над карточкой: они меняют ровно одну строку,
 * и вернуть её прежнее содержимое достаточно.
 */
export async function restoreProgress(
  db: AppDatabase,
  cardId: string,
  previous: PreviousProgress,
  now: Date = new Date(),
): Promise<void> {
  const release = updateSafety.begin();
  try {
    await db.transaction("rw", db.progress, db.changes, db.cards, async () => {
      const deckId = previous?.deckId ?? (await db.progress.get(cardId))?.deckId ?? (await db.cards.get(cardId))?.deckId ?? (await db.changes.get(cardId))?.deckId;
      if (deckId === undefined) throw new Error("карточка не найдена");
      await assertAvailableOwners(db, [{ cardId, deckId }]);
      await markChanged(db, cardId, deckId, now);
      if (previous === null) await db.progress.delete(cardId);
      else await db.progress.put(previous);
    });
  } finally { release(); }
}

/** Сколько карточек колоды убрано из оборота. */
export async function hiddenCount(
  db: AppDatabase,
  deckId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db.progress.where("deckId").equals(deckId).toArray();
  return rows.filter((row) => isHidden(row, now)).length;
}

/** Текущий прогресс по карточке, если он есть. */
export async function getProgress(
  db: AppDatabase,
  cardId: string,
): Promise<CardProgress | undefined> {
  return db.progress.get(cardId);
}
