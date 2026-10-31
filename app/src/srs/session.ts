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
  /** Карточки, убранные действием, а не завершённые ответом. */
  excluded: number;
  repeats: number;
  firstAnswered: number;
  firstRecalled: number;
}

interface PendingCard {
  card: DeckCard;
  due: number;
}

/** Одна обратимая правка; размер не зависит от длины очереди и журнала. */
interface SessionChange {
  parent: SessionChange | null;
  removed: PendingCard;
  index: number;
  addedIndex: number | null;
  kind: "answer" | "drop";
  firstGrade: Grade | null;
}

/** Маркер позиции в истории; полные списки сюда не копируются. */
export interface SessionSnapshot {
  readonly owner: symbol;
  readonly change: SessionChange | null;
  readonly activeId: string | null;
}

export interface Session {
  current(): DeckCard | null;
  answer(grade: Grade, nextDue?: string): void;
  drop(): void;
  progress(): SessionProgress;
  isFinished(): boolean;
  nextDue(): string | null;
  snapshot(): SessionSnapshot;
  /** Откат к предку текущей истории; чужие и отменённые ветки отклоняются. */
  restore(snapshot: SessionSnapshot): void;
}

export function createSession(
  cards: readonly DeckCard[],
  options: SessionOptions = {},
): Session {
  const clock = options.clock ?? (() => new Date());
  const queue: PendingCard[] = [];
  const included = new Set<string>();
  for (const card of cards) {
    if (!included.has(card.id)) {
      queue.push({ card, due: 0 });
      included.add(card.id);
    }
  }
  for (const item of options.pending ?? []) {
    if (!included.has(item.card.id)) {
      const due = Date.parse(item.due);
      if (!Number.isFinite(due)) throw new Error("Некорректный срок повтора.");
      queue.push({ card: item.card, due });
      included.add(item.card.id);
    }
  }
  queue.sort((a, b) => a.due - b.due);
  let answered = 0,
    completed = 0,
    excluded = 0,
    firstRecalled = 0;
  const firstGrades = new Map<string, Grade>();
  let activeId: string | null = null;
  const owner = Symbol("session");
  let change: SessionChange | null = null;

  function ready() {
    if (activeId !== null)
      return queue.findIndex((item) => item.card.id === activeId);
    const now = clock().getTime();
    const repeat = queue.findIndex((item) => item.due > 0 && item.due <= now);
    const index =
      repeat >= 0 ? repeat : queue.findIndex((item) => item.due <= now);
    activeId = queue[index]?.card.id ?? null;
    return index;
  }
  function insert(item: PendingCard) {
    // Стабильная вставка без пересортировки всей очереди после каждого ответа.
    let low = 0,
      high = queue.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (queue[middle]!.due <= item.due) low = middle + 1;
      else high = middle;
    }
    queue.splice(low, 0, item);
    return low;
  }
  return {
    current: () => queue[ready()]?.card ?? null,
    answer(grade, nextDue) {
      const due = nextDue === undefined ? null : Date.parse(nextDue);
      if (due !== null && !Number.isFinite(due))
        throw new Error("Некорректный срок повтора.");
      const index = ready();
      if (index < 0) return;
      const item = queue.splice(index, 1)[0]!;
      const firstGrade = firstGrades.has(item.card.id) ? null : grade;
      const addedIndex = due === null ? null : insert({ card: item.card, due });
      change = {
        parent: change,
        removed: item,
        index,
        addedIndex,
        kind: "answer",
        firstGrade,
      };
      activeId = null;
      answered++;
      if (firstGrade !== null) {
        firstGrades.set(item.card.id, firstGrade);
        if (firstGrade !== "again") firstRecalled++;
      }
      if (addedIndex === null) completed++;
    },
    drop() {
      const index = ready();
      if (index < 0) return;
      const item = queue.splice(index, 1)[0]!;
      change = {
        parent: change,
        removed: item,
        index,
        addedIndex: null,
        kind: "drop",
        firstGrade: null,
      };
      activeId = null;
      excluded++;
    },
    progress: () => ({
      remaining: queue.length,
      answered,
      completed,
      excluded,
      repeats: answered - firstGrades.size,
      firstAnswered: firstGrades.size,
      firstRecalled,
    }),
    isFinished: () => queue.length === 0,
    nextDue() {
      let due = Infinity;
      for (const item of queue) due = Math.min(due, item.due);
      return Number.isFinite(due) ? new Date(due).toISOString() : null;
    },
    snapshot: () => ({ owner, change, activeId }),
    restore(snapshot) {
      if (snapshot.owner !== owner)
        throw new Error("Снимок относится к другому занятию.");
      // Сначала проверяем достижимость: ошибка не должна частично менять очередь.
      let cursor = change;
      while (cursor !== snapshot.change) {
        if (cursor === null)
          throw new Error("Ветка истории занятия уже отменена.");
        cursor = cursor.parent;
      }
      while (change !== snapshot.change && change !== null) {
        const step = change;
        if (step.addedIndex !== null) queue.splice(step.addedIndex, 1);
        queue.splice(step.index, 0, step.removed);
        if (step.kind === "drop") excluded--;
        else {
          answered--;
          if (step.addedIndex === null) completed--;
          if (step.firstGrade !== null) {
            firstGrades.delete(step.removed.card.id);
            if (step.firstGrade !== "again") firstRecalled--;
          }
        }
        change = step.parent;
      }
      activeId = snapshot.activeId;
    },
  };
}
