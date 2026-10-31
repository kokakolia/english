/** Порядок занятия и короткие повторы по времени, назначенному планировщиком. */
import type { DeckCard, Grade } from "./types";

export interface SessionOptions {
  clock?: () => Date;
  pending?: readonly { card: DeckCard; due: string }[];
}

export interface SessionProgress {
  remaining: number;
  answered: number;
  /** Карточки без ожидающего короткого повтора. */
  completed: number;
  /** Дополнительные попытки, которые уже состоялись. */
  repeats: number;
  firstAnswered: number;
  /** С первого раза вспомнены hard/good/easy. */
  firstRecalled: number;
}

interface PendingCard {
  card: DeckCard;
  due: number;
}

export interface SessionSnapshot {
  queue: readonly PendingCard[];
  activeId: string | null;
  answered: number;
  completed: number;
  firstGrades: readonly (readonly [string, Grade])[];
}

export interface Session {
  current(): DeckCard | null;
  /** nextDue передаётся только для learning/relearning, без собственной эвристики. */
  answer(grade: Grade, nextDue?: string): void;
  drop(): void;
  progress(): SessionProgress;
  isFinished(): boolean;
  nextDue(): string | null;
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): void;
}

export function createSession(
  cards: readonly DeckCard[],
  options: SessionOptions = {},
): Session {
  const clock = options.clock ?? (() => new Date());
  const queue: PendingCard[] = cards.map((card) => ({ card, due: 0 }));
  const included = new Set(cards.map((card) => card.id));
  for (const item of options.pending ?? []) {
    if (!included.has(item.card.id)) {
      queue.push({ card: item.card, due: Date.parse(item.due) });
      included.add(item.card.id);
    }
  }
  queue.sort((a, b) => a.due - b.due);
  let answered = 0,
    completed = 0;
  const firstGrades = new Map<string, Grade>();
  let activeId: string | null = null;
  function ready() {
    // Уже показанная карточка закреплена: наступивший в это время повтор
    // не должен получить оценку вместо неё.
    if (activeId !== null)
      return queue.findIndex((item) => item.card.id === activeId);
    const now = clock().getTime();
    const repeat = queue.findIndex((item) => item.due > 0 && item.due <= now);
    const index =
      repeat >= 0 ? repeat : queue.findIndex((item) => item.due <= now);
    activeId = queue[index]?.card.id ?? null;
    return index;
  }
  return {
    current: () => queue[ready()]?.card ?? null,
    answer(grade, nextDue) {
      const index = ready();
      if (index < 0) return;
      const [item] = queue.splice(index, 1);
      if (!item) return;
      activeId = null;
      answered++;
      if (!firstGrades.has(item.card.id)) firstGrades.set(item.card.id, grade);
      if (nextDue !== undefined) {
        queue.push({ card: item.card, due: Date.parse(nextDue) });
        queue.sort((a, b) => a.due - b.due);
      } else completed++;
    },
    drop() {
      const index = ready();
      if (index >= 0) queue.splice(index, 1);
      activeId = null;
    },
    progress: () => ({
      remaining: queue.length,
      answered,
      completed,
      repeats: answered - firstGrades.size,
      firstAnswered: firstGrades.size,
      firstRecalled: [...firstGrades.values()].filter(
        (grade) => grade !== "again",
      ).length,
    }),
    isFinished: () => queue.length === 0,
    nextDue: () =>
      queue.length
        ? new Date(Math.min(...queue.map((item) => item.due))).toISOString()
        : null,
    snapshot: () => ({
      queue: queue.slice(),
      activeId,
      answered,
      completed,
      firstGrades: [...firstGrades],
    }),
    restore(snapshot) {
      queue.length = 0;
      queue.push(...snapshot.queue);
      activeId = snapshot.activeId;
      answered = snapshot.answered;
      completed = snapshot.completed;
      firstGrades.clear();
      for (const [id, grade] of snapshot.firstGrades)
        firstGrades.set(id, grade);
    },
  };
}
