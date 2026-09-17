/**
 * Ход занятия: что показано на экране и что происходит по нажатию.
 *
 * Это не часть интерфейса, а его собеседник. React-компоненты подписываются на
 * состояние и вызывают методы; вся логика — какая карточка следующая, засчитан
 * ли ответ, когда писать в базу — живёт здесь. Причин две.
 *
 * Первая: это можно проверить тестами без браузера и без React.
 *
 * Вторая: дизайн экрана мы будем переделывать, и не один раз. Переписывать
 * вёрстку, не трогая логику занятия, гораздо дешевле, чем выковыривать логику
 * из компонентов.
 *
 * Отдельное обязательство — **ответ записывается до перехода к следующей
 * карточке**. Учащийся нажал оценку, поехала анимация, вкладку закрыли: к
 * этому моменту прогресс и запись журнала уже должны быть на диске.
 */

import {
  buildQueue,
  checkAnswer,
  createSession,
  defaultScheduler,
  type AnswerCheck,
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
  /** Показан пропуск, ждём ответа. */
  | "question"
  /** Ответ показан, ждём оценки. */
  | "answered"
  /** Очередь пройдена. */
  | "finished";

export interface StudyState {
  phase: StudyPhase;
  card: DeckCard | null;
  /** Что набрано в поле ввода. */
  typed: string;
  /** Итог проверки. `null`, если ответ был раскрыт без попытки. */
  check: AnswerCheck | null;
  hintVisible: boolean;
  /** Сколько дней до следующего показа при каждой оценке. */
  intervals: Record<Grade, number> | null;
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
  setTyped(value: string): void;
  showHint(): void;
  /** Проверить набранное. */
  submit(): void;
  /** Показать ответ, не отвечая. */
  reveal(): void;
  /** Оценить карточку, записать и перейти дальше. */
  grade(grade: Grade): Promise<void>;
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

/**
 * Какую оценку предложить по умолчанию.
 *
 * Не решение за учащегося, а подсказка интерфейсу: после верного ответа палец
 * тянется к «good», после неверного — к «again».
 */
export function suggestedGrade(check: AnswerCheck | null): Grade {
  if (check === null) return "again";
  return check.verdict === "correct" ? "good" : "again";
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
    typed: "",
    check: null,
    hintVisible: false,
    intervals: null,
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
        typed: "",
        check: null,
        hintVisible: false,
        intervals: null,
        session: session?.progress() ?? EMPTY_SESSION,
      });
      return;
    }
    publish({
      phase: "question",
      card,
      typed: "",
      check: null,
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

    setTyped(value) {
      if (state.phase !== "question") return;
      publish({ typed: value });
    },

    showHint() {
      if (state.phase !== "question") return;
      publish({ hintVisible: true });
    },

    submit() {
      const card = state.card;
      if (state.phase !== "question" || card === null) return;
      if (state.typed.trim() === "") return;

      let check = checkAnswer(state.typed, card);
      // Опечатку можно засчитывать автоматически — это настройка, а не
      // решение ядра: кто-то хочет строгости, кто-то нет.
      if (check.verdict === "almost" && settings.acceptTypos) {
        check = { ...check, verdict: "correct" };
      }
      publish({ phase: "answered", check, intervals: previewIntervals(card) });
    },

    reveal() {
      const card = state.card;
      if (state.phase !== "question" || card === null) return;
      // Ответ раскрыт без попытки: проверять нечего, но и «неверно» это не
      // совсем — вердикт остаётся пустым, а оценку ставит человек.
      publish({ phase: "answered", check: null, intervals: previewIntervals(card) });
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
          ...(state.typed.trim() !== "" ? { typed: state.typed } : {}),
          ...(state.check !== null ? { verdict: state.check.verdict } : {}),
          scheduler,
        });
        progress.set(card.id, result.progress);
      } catch (cause) {
        publish({ saving: false, error: `не удалось сохранить ответ: ${String(cause)}` });
        return;
      }

      session?.answer(grade);
      publish({ saving: false });
      advance();
    },

    restart: build,
  };
}
