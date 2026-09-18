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
  type SessionSnapshot,
} from "../srs";
import {
  getStudySettings,
  loadCards,
  loadProgress,
  recordReview,
  undoReview,
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
  /** Очередь пройдена, показаны итоги. */
  | "finished";

export interface StudyState {
  phase: StudyPhase;
  card: DeckCard | null;
  hintVisible: boolean;
  /** Сколько дней до следующего показа при каждой оценке. */
  intervals: Record<Grade, number> | null;
  /**
   * Сколько раз за занятие поставлена каждая оценка.
   *
   * Нужна для итогов в конце. Считается по ответам, а не по карточкам:
   * карточка, на которой ошиблись, возвращается и оценивается снова.
   */
  tally: Record<Grade, number>;
  counts: QueueCounts;
  backlog: number;
  session: SessionProgress;
  /** Есть ли что отменять: хотя бы одна оценка за это занятие. */
  canUndo: boolean;
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
  /** Оценить карточку, записать и перейти к следующей. */
  grade(grade: Grade): Promise<void>;
  /**
   * Отменить последнюю оценку и вернуться к той карточке с раскрытым ответом.
   * Отменять можно подряд, до начала занятия.
   */
  undo(): Promise<void>;
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

const EMPTY_TALLY: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };

/** Что должно произойти по нажатию клавиши. */
export type KeyAction =
  | { kind: "reveal" }
  | { kind: "grade"; grade: Grade }
  | { kind: "undo" }
  | null;

/**
 * Что нужно знать, чтобы отменить одну оценку.
 *
 * Здесь лежит именно то состояние, которое оценка меняет и которое нельзя
 * вычислить обратно: прогресс FSRS (переход необратим), порядок очереди
 * (карточка могла уехать в середину) и счёт оценок.
 */
interface UndoStep {
  card: DeckCard;
  grade: Grade;
  reviewId: number;
  previous: StoredProgress | null;
  session: SessionSnapshot;
}

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
  if (phase === "loading" || phase === "empty") return null;

  if (phase === "question") {
    if (key === " " || key === "Enter") return { kind: "reveal" };
  }
  // Отмена нужна именно тогда, когда следующая карточка уже на экране: промах
  // по кнопке замечают, увидев не то предложение. Поэтому она работает во всех
  // рабочих состояниях, а не только там, где видны кнопки оценки.
  if (key === "Backspace") return { kind: "undo" };

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
    tally: { ...EMPTY_TALLY },
    counts: EMPTY_COUNTS,
    backlog: 0,
    session: EMPTY_SESSION,
    canUndo: false,
    saving: false,
    error: null,
  };

  const listeners = new Set<(state: StudyState) => void>();
  let cards: DeckCard[] = [];
  let progress = new Map<string, StoredProgress>();
  let settings = await getStudySettings(db);
  let session: Session | null = null;
  const undoStack: UndoStep[] = [];

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
        session: session?.progress() ?? EMPTY_SESSION,
      });
      return;
    }
    publish({
      phase: "question",
      card,
      hintVisible: false,
      intervals: null,
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

      session = createSession(queue.cards, {
        againGap: settings.againGap,
        repeatHard: settings.repeatHard,
        hardGap: settings.hardGap,
      });
      undoStack.length = 0;
      publish({
        tally: { ...EMPTY_TALLY },
        counts: queue.counts,
        backlog: queue.backlog,
        session: session.progress(),
        canUndo: false,
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
      try {
        // Запись идёт до перехода к следующей карточке: если вкладку закроют
        // на анимации, ответ уже на диске.
        const result = await recordReview(db, {
          cardId: card.id,
          deckId,
          grade,
          now: clock(),
          scheduler,
        });
        progress.set(card.id, result.progress);
        // Снимок снимается до `session.answer`, иначе он опишет уже
        // изменённую очередь и возврат приведёт не туда.
        if (session !== null) {
          undoStack.push({
            card,
            grade,
            reviewId: result.reviewId,
            previous: result.previous,
            session: session.snapshot(),
          });
        }
      } catch (cause) {
        publish({ saving: false, error: `не удалось сохранить ответ: ${String(cause)}` });
        return;
      }

      session?.answer(grade);
      publish({
        saving: false,
        tally: { ...state.tally, [grade]: state.tally[grade] + 1 },
        canUndo: undoStack.length > 0,
      });
      advance();
    },

    async undo() {
      if (state.saving || undoStack.length === 0) return;
      if (state.phase === "loading" || state.phase === "empty") return;

      const step = undoStack[undoStack.length - 1];
      if (step === undefined) return;

      publish({ saving: true, error: null });
      try {
        await undoReview(db, {
          cardId: step.card.id,
          reviewId: step.reviewId,
          previous: step.previous,
        });
      } catch (cause) {
        publish({ saving: false, error: `не удалось отменить ответ: ${String(cause)}` });
        return;
      }

      // Со шага снимаем только после успешной записи: иначе неудачная отмена
      // потеряет возможность попробовать ещё раз.
      undoStack.pop();
      if (step.previous === null) progress.delete(step.card.id);
      else progress.set(step.card.id, step.previous);
      session?.restore(step.session);

      const tally = { ...state.tally };
      tally[step.grade] = Math.max(0, tally[step.grade] - 1);

      publish({
        phase: "answered",
        card: step.card,
        hintVisible: false,
        intervals: previewIntervals(step.card),
        tally,
        session: session?.progress() ?? EMPTY_SESSION,
        canUndo: undoStack.length > 0,
        saving: false,
      });
    },

    restart: build,
  };
}
