/**
 * Планировщик повторений — обёртка над `ts-fsrs`.
 *
 * Свой алгоритм мы не пишем: FSRS — результат многолетнего анализа реальных
 * логов повторений, и повторить его «на глаз» невозможно. Задача обёртки в
 * другом: держать между библиотекой и приложением собственный формат прогресса,
 * который можно сериализовать, положить в хранилище и выгрузить в файл.
 *
 * Библиотека оперирует объектами `Date` и числовыми перечислениями; наружу мы
 * отдаём строки ISO и понятные строковые состояния. Благодаря этому обновление
 * `ts-fsrs` не ломает формат уже накопленного прогресса.
 */

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type FSRS,
  type Grade as FsrsGrade,
} from "ts-fsrs";

import type { CardProgress, CardState, Grade } from "./types";

export interface SchedulerOptions {
  /**
   * Доля карточек, которые учащийся должен вспоминать успешно. Ниже — реже
   * повторения и больше забывания, выше — чаще повторения и больше работы.
   */
  requestRetention?: number;
  /** Верхняя граница интервала в днях. */
  maximumInterval?: number;
  /**
   * Случайный разброс интервалов. Нужен, чтобы карточки, выученные в один день,
   * не возвращались потом вечно одной пачкой. В тестах выключается.
   */
  enableFuzz?: boolean;
}

const STATE_TO_NAME: Record<number, CardState> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const NAME_TO_STATE: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

// Тип библиотеки исключает служебное значение `Manual`, поэтому таблица
// типизирована именно им: случайно передать «ручную» оценку не получится.
const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

function toProgress(cardId: string, card: FsrsCard): CardProgress {
  return {
    cardId,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_TO_NAME[card.state] ?? "new",
    lastReview: card.last_review ? card.last_review.toISOString() : null,
  };
}

function toFsrsCard(progress: CardProgress): FsrsCard {
  return {
    due: new Date(progress.due),
    stability: progress.stability,
    difficulty: progress.difficulty,
    elapsed_days: progress.elapsedDays,
    scheduled_days: progress.scheduledDays,
    reps: progress.reps,
    lapses: progress.lapses,
    state: NAME_TO_STATE[progress.state],
    last_review: progress.lastReview
      ? new Date(progress.lastReview)
      : undefined,
  };
}

export interface ReviewOutcome {
  progress: CardProgress;
  /** Сколько дней до следующего показа. */
  intervalDays: number;
}

export interface Scheduler {
  /** Прогресс для карточки, которую ещё ни разу не показывали. */
  create(cardId: string, now: Date): CardProgress;
  /** Применить оценку и получить новое состояние. */
  review(progress: CardProgress, grade: Grade, now: Date): ReviewOutcome;
  /**
   * Что будет при каждой из оценок, без применения. Нужно, чтобы показать
   * учащемуся сроки на кнопках до того, как он выберет.
   */
  preview(progress: CardProgress, now: Date): Record<Grade, ReviewOutcome>;
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const engine: FSRS = fsrs(
    generatorParameters({
      request_retention: options.requestRetention ?? 0.9,
      maximum_interval: options.maximumInterval ?? 36500,
      enable_fuzz: options.enableFuzz ?? true,
    }),
  );

  function applyGrade(
    progress: CardProgress,
    grade: Grade,
    now: Date,
  ): ReviewOutcome {
    const { card } = engine.next(
      toFsrsCard(progress),
      now,
      GRADE_TO_RATING[grade],
    );
    const next = toProgress(progress.cardId, card);
    return {
      progress: next,
      intervalDays: (card.due.getTime() - now.getTime()) / 86_400_000,
    };
  }

  return {
    create(cardId, now) {
      return toProgress(cardId, createEmptyCard(now));
    },

    review(progress, grade, now) {
      return applyGrade(progress, grade, now);
    },

    preview(progress, now) {
      return {
        again: applyGrade(progress, "again", now),
        hard: applyGrade(progress, "hard", now),
        good: applyGrade(progress, "good", now),
        easy: applyGrade(progress, "easy", now),
      };
    },
  };
}

/** Планировщик с настройками по умолчанию. */
export const defaultScheduler = createScheduler();

/** Наступил ли срок показа. */
export function isDue(progress: CardProgress, now: Date): boolean {
  return new Date(progress.due).getTime() <= now.getTime();
}

/**
 * Убрана ли карточка из оборота рукой человека.
 *
 * Проверяется раньше срока показа: приостановленная карточка не должна
 * попадать в очередь, даже когда её срок давно наступил.
 */
export function isHidden(progress: CardProgress, now: Date): boolean {
  if (progress.suspended === true) return true;
  const buried = progress.buriedUntil;
  if (buried === undefined || buried === null) return false;
  return new Date(buried).getTime() > now.getTime();
}

/** Начало следующих суток по местному времени — докуда закапывается карточка. */
export function nextDayStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  return start;
}
