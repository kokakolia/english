/**
 * Ход занятия: что показано на экране и что происходит по нажатию.
 *
 * Это не часть интерфейса, а его собеседник. React-компоненты подписываются на
 * состояние и вызывают методы; вся логика — какая карточка следующая, когда
 * писать в базу — живёт здесь. Причин две.
 *
 * Первая: это можно проверить тестами без браузера и без React.
 *
 * Вторая: дизайн экрана мы будем переделывать, и не один раз. Переписывать
 * вёрстку, не трогая логику занятия, гораздо дешевле, чем выковыривать логику
 * из компонентов.
 *
 * Проверяет себя сам учащийся. Система не спрашивает ответ и не судит его: она
 * показывает пропуск, по требованию раскрывает карточку и принимает оценку.
 * Так устроен Anki, и так честнее — знание своего ответа есть только у того,
 * кто вспоминал.
 *
 * Отдельное обязательство — **ответ записывается до перехода к следующей
 * карточке**. Учащийся нажал оценку, поехала анимация, вкладку закрыли: к
 * этому моменту прогресс и запись журнала уже должны быть на диске.
 */

import {
  buildQueue,
  createSession,
  defaultScheduler,
  GRADES,
  type DeckCard,
  type Grade,
  type QueueCounts,
  type Scheduler,
  type Session,
  type SessionProgress,
} from "../srs";
import {
  getStudySettings,
  loadCards,
  loadProgress,
  recordReview,
  type AppDatabase,
  type StoredProgress,
  type StudySettings,
} from "../storage";

export type StudyPhase =
  /** Очередь ещё строится. */
  | "loading"
  /** На сегодня всё: очередь пуста с самого начала. */
  | "empty"
  /** Показан пропуск, ответ скрыт. */
  | "question"
  /** Ответ раскрыт, ждём оценки. */
  | "answered"
  /** Оценка принята, показан отклик и срок следующего показа. */
  | "feedback"
  /** Очередь пройдена. */
  | "finished";

export interface StudyState {
  phase: StudyPhase;
  card: DeckCard | null;
  hintVisible: boolean;
  /** Сколько дней до следующего показа при каждой оценке. */
  intervals: Record<Grade, number> | null;
  /** Поставленная оценка — показывается на экране отклика. */
  lastGrade: Grade | null;
  /** Срок следующего показа в днях. */
  lastInterval: number | null;
  counts: QueueCounts;
  backlog: number;
  session: SessionProgress;
  /** Идёт запись в базу: кнопки оценки на это время блокируются. */
  saving: boolean;
  error: string | null;
}

export interface StudyController {
  state(): StudyState;
  subscribe(listener: (state: StudyState) => void): () => void;
  showHint(): void;
  /** Раскрыть ответ. */
  reveal(): void;
  /** Оценить карточку и записать. Переход к следующей — отдельным шагом. */
  grade(grade: Grade): Promise<void>;
  /** Перейти к следующей карточке с экрана отклика. */
  next(): void;
  /** Построить очередь заново — например, после смены настроек. */
  restart(): Promise<void>;
  settings(): StudySettings;
}

export interface StudyOptions {
  db: AppDatabase;
  deckId: string;
  /** Часы. Подменяются в тестах. */
  clock?: () => Date;
  scheduler?: Scheduler;
  /** Зерно перемешивания очереди. По умолчанию — номер дня. */
  seed?: number;
}

const EMPTY_COUNTS: QueueCounts = { fresh: 0, learning: 0, review: 0, total: 0 };
const EMPTY_SESSION: SessionProgress = {
  remaining: 0,
  answered: 0,
  completed: 0,
  repeats: 0,
};

/** Что должно произойти по нажатию клавиши. */
export type KeyAction =
  | { kind: "reveal" }
  | { kind: "grade"; grade: Grade }
  | { kind: "next" }
  | null;

/**
 * Разбор нажатия — отдельной чистой функцией.
 *
 * Так сделано из-за ошибки, которая иначе неизбежна. Если обработчик клавиш
 * перевешивать при каждой смене состояния, одно нажатие Enter успевает
 * раскрыть карточку и тут же её оценить: React перерисовывает экран внутри
 * того же события, а обработчик, добавленный на цель, до которой событие ещё
 * не дошло, по спецификации DOM всё равно срабатывает.
 *
 * Поэтому обработчик вешается один раз и спрашивает состояние сам, а решение
 * «что делать по этой клавише» живёт здесь и проверяется тестами.
 */
export function keyAction(phase: StudyPhase, key: string): KeyAction {
  if (phase === "question") {
    return key === " " || key === "Enter" ? { kind: "reveal" } : null;
  }
  if (phase === "feedback") {
    return key === " " || key === "Enter" ? { kind: "next" } : null;
  }
  if (phase !== "answered") return null;

  const index = ["1", "2", "3", "4"].indexOf(key);
  if (index >= 0) {
    const grade = GRADES[index];
    return grade === undefined ? null : { kind: "grade", grade };
  }
  // Пробел и Enter ставят «хорошо» — как в Anki, где это движение уже в
  // пальцах у всех, кто пользовался карточками.
  if (key === " " || key === "Enter") return { kind: "grade", grade: "good" };
  return null;
}

export async function createStudyController(
  options: StudyOptions,
): Promise<StudyController> {
  const { db, deckId } = options;
  const clock = options.clock ?? (() => new Date());
  const scheduler = options.scheduler ?? defaultScheduler;

  let state: StudyState = {
    phase: "loading",
    card: null,
    hintVisible: false,
    intervals: null,
    lastGrade: null,
    lastInterval: null,
    counts: EMPTY_COUNTS,
    backlog: 0,
    session: EMPTY_SESSION,
    saving: false,
    error: null,
  };

  const listeners = new Set<(state: StudyState) => void>();
  let cards: DeckCard[] = [];
  let progress = new Map<string, StoredProgress>();
  let settings = await getStudySettings(db);
  let session: Session | null = null;

  function publish(patch: Partial<StudyState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  /** Сроки на кнопках оценки: их видно до того, как выбрал. */
  function previewIntervals(card: DeckCard): Record<Grade, number> {
    const now = clock();
    const current =
      progress.get(card.id) ??
      ({ ...scheduler.create(card.id, now), deckId } as StoredProgress);
    const preview = scheduler.preview(current, now);
    return {
      again: preview.again.intervalDays,
      hard: preview.hard.intervalDays,
      good: preview.good.intervalDays,
      easy: preview.easy.intervalDays,
    };
  }

  function advance(): void {
    const card = session?.current() ?? null;
    if (card === null) {
      publish({
        phase: "finished",
        card: null,
        hintVisible: false,
        intervals: null,
        lastGrade: null,
        lastInterval: null,
        session: session?.progress() ?? EMPTY_SESSION,
      });
      return;
    }
    publish({
      phase: "question",
      card,
      hintVisible: false,
      intervals: null,
      lastGrade: null,
      lastInterval: null,
      session: session?.progress() ?? EMPTY_SESSION,
    });
  }

  async function build(): Promise<void> {
    publish({ phase: "loading", error: null });
    try {
      settings = await getStudySettings(db);
      cards = await loadCards(db, deckId);
      progress = await loadProgress(db, deckId);

      const now = clock();
      const queue = buildQueue({
        cards,
        progress,
        settings: {
          newPerDay: settings.newPerDay,
          reviewsPerDay: settings.reviewsPerDay,
          siblingGap: settings.siblingGap,
          seed: options.seed ?? Math.floor(now.getTime() / 86_400_000),
        },
        now,
      });

      session = createSession(queue.cards, { againGap: settings.againGap });
      publish({
        counts: queue.counts,
        backlog: queue.backlog,
        session: session.progress(),
      });

      if (queue.cards.length === 0) {
        publish({ phase: "empty", card: null });
        return;
      }
      advance();
    } catch (cause) {
      publish({ phase: "empty", error: `не удалось собрать очередь: ${String(cause)}` });
    }
  }

  await build();

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    settings: () => settings,

    showHint() {
      if (state.phase !== "question") return;
      publish({ hintVisible: true });
    },

    reveal() {
      const card = state.card;
      if (state.phase !== "question" || card === null) return;
      publish({ phase: "answered", intervals: previewIntervals(card) });
    },

    async grade(grade) {
      const card = state.card;
      if (state.phase !== "answered" || card === null || state.saving) return;

      publish({ saving: true, error: null });
      let intervalDays = 0;
      try {
        // Запись идёт до показа отклика: если вкладку закроют прямо сейчас,
        // ответ уже на диске.
        const result = await recordReview(db, {
          cardId: card.id,
          deckId,
          grade,
          now: clock(),
          scheduler,
        });
        progress.set(card.id, result.progress);
        intervalDays = result.intervalDays;
      } catch (cause) {
        publish({ saving: false, error: `не удалось сохранить ответ: ${String(cause)}` });
        return;
      }

      // Очередь двигается сразу, а карточка на экране — нет: отклик
      // показывается по уже применённой оценке.
      session?.answer(grade);
      publish({
        phase: "feedback",
        saving: false,
        lastGrade: grade,
        lastInterval: intervalDays,
        session: session?.progress() ?? EMPTY_SESSION,
      });
    },

    next() {
      if (state.phase !== "feedback") return;
      advance();
    },

    restart: build,
  };
}
