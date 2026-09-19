/**
 * Ядро интервального повторения.
 *
 * Здесь сосредоточена вся корректность приложения: расписание повторений и
 * проверка ответа. Ошибка в них не видна глазом — карточки будут показываться,
 * просто не в те дни, и обнаружится это через месяцы. Поэтому ядро отделено от
 * интерфейса и хранилища: оно принимает данные и возвращает данные, ничего не
 * знает ни про React, ни про базу, и проверяется тестами, которые прогоняют
 * год повторений за секунды.
 */

export type {
  AnswerCheck,
  AnswerReason,
  AnswerVerdict,
  CardProgress,
  CardState,
  DeckCard,
  Grade,
  ReviewEntry,
} from "./types";
export { GRADES } from "./types";

export {
  createScheduler,
  defaultScheduler,
  isDue,
  isHidden,
  nextDayStart,
  type ReviewOutcome,
  type Scheduler,
  type SchedulerOptions,
} from "./scheduler";

export { checkAnswer, normalizeInput, type GradableCard } from "./grade";
export { comparableForm, editDistance, sameWord } from "./lemma";

export {
  buildQueue,
  createRandom,
  DEFAULT_SETTINGS,
  familyKey,
  interleave,
  spaceOutSiblings,
  type BuildQueueInput,
  type DayQueue,
  type ProgressLookup,
  type QueueCounts,
  type QueueSettings,
} from "./queue";

export {
  createSession,
  type Session,
  type SessionOptions,
  type SessionProgress,
  type SessionSnapshot,
} from "./session";
