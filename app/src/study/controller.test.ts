import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import {
  AppDatabase,
  cardHistory,
  importDeck,
  updateStudySettings,
  type DeckFile,
} from "../storage";
import { createStudyController, keyAction, type StudyController } from "./controller";

const scheduler = createScheduler({ enableFuzz: false });
const NOW = new Date("2026-07-01T09:00:00Z");

function deckFile(cards: ReturnType<typeof makeCard>[]): DeckFile {
  return {
    meta: {
      id: "deck",
      name: "Колода",
      version: "v1",
      language: "en",
      card_type: "cloze",
      built_at: NOW.toISOString(),
      count: cards.length,
      chunks: ["cards-000.json"],
    },
    cards,
  };
}

function sampleCards() {
  return [
    makeCard({
      id: "c_1",
      position: 1,
      headword: "decision",
      text: "We need to ___ a decision by Friday.",
      answer: "make",
      answers: ["make", "take", "reach"],
      also: ["take", "reach"],
      hint: "m___",
    }),
    makeCard({
      id: "c_2",
      position: 2,
      headword: "time",
      text: "Do you ___ time to help me today?",
      answer: "have",
      answers: ["have"],
      hint: "h___",
    }),
    makeCard({
      id: "c_3",
      position: 3,
      headword: "world",
      text: "She dreams of ___ the world.",
      answer: "seeing",
      answers: ["see", "seeing"],
      hint: "s_____",
    }),
  ];
}

let db: AppDatabase;
let counter = 0;

async function makeController(
  overrides: Partial<Parameters<typeof createStudyController>[0]> = {},
): Promise<StudyController> {
  return createStudyController({
    db,
    deckId: "deck",
    clock: () => NOW,
    scheduler,
    seed: 1,
    ...overrides,
  });
}

beforeEach(async () => {
  counter += 1;
  db = new AppDatabase(`study-${counter}`);
  await db.open();
  await importDeck(db, deckFile(sampleCards()), { now: NOW });
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe("начало занятия", () => {
  it("строит очередь и показывает первую карточку", async () => {
    const controller = await makeController();
    const state = controller.state();

    expect(state.phase).toBe("question");
    expect(state.card).not.toBeNull();
    expect(state.counts.fresh).toBe(3);
    expect(state.session.remaining).toBe(3);
  });

  it("сообщает, когда на сегодня ничего нет", async () => {
    await updateStudySettings(db, { newPerDay: 0, reviewsPerDay: 0 });
    const controller = await makeController();

    expect(controller.state().phase).toBe("empty");
    expect(controller.state().card).toBeNull();
  });

  it("уважает дневной лимит новых карточек", async () => {
    await updateStudySettings(db, { newPerDay: 2 });
    const controller = await makeController();
    expect(controller.state().counts.fresh).toBe(2);
    expect(controller.state().session.remaining).toBe(2);
  });
});

describe("раскрытие карточки", () => {
  it("переводит в состояние с ответом", async () => {
    const controller = await makeController();
    controller.reveal();
    expect(controller.state().phase).toBe("answered");
  });

  it("показывает сроки на кнопках до выбора оценки", async () => {
    const controller = await makeController();
    controller.reveal();

    const intervals = controller.state().intervals!;
    expect(intervals.again).toBeLessThanOrEqual(intervals.good);
    expect(intervals.good).toBeLessThan(intervals.easy);
  });

  it("повторное раскрытие ничего не ломает", async () => {
    const controller = await makeController();
    const first = controller.state().card?.id;
    controller.reveal();
    controller.reveal();

    expect(controller.state().phase).toBe("answered");
    expect(controller.state().card?.id).toBe(first);
  });

  it("подсказка показывается по требованию и гаснет на следующей карточке", async () => {
    const controller = await makeController();
    expect(controller.state().hintVisible).toBe(false);

    controller.showHint();
    expect(controller.state().hintVisible).toBe(true);

    controller.reveal();
    await controller.grade("good");
    expect(controller.state().hintVisible).toBe(false);
  });
});

describe("разбор нажатий", () => {
  it("на скрытом ответе пробел и Enter раскрывают карточку", () => {
    expect(keyAction("question", " ")).toEqual({ kind: "reveal" });
    expect(keyAction("question", "Enter")).toEqual({ kind: "reveal" });
  });

  it("на скрытом ответе цифры ничего не делают", () => {
    // Иначе одно нажатие раскрывало бы карточку и сразу ставило оценку —
    // ровно та ошибка, ради которой разбор вынесен в отдельную функцию.
    expect(keyAction("question", "3")).toBeNull();
  });

  it("на раскрытом ответе цифры ставят оценку", () => {
    expect(keyAction("answered", "1")).toEqual({ kind: "grade", grade: "again" });
    expect(keyAction("answered", "4")).toEqual({ kind: "grade", grade: "easy" });
  });

  it("на раскрытом ответе пробел и Enter ставят «хорошо»", () => {
    expect(keyAction("answered", " ")).toEqual({ kind: "grade", grade: "good" });
    expect(keyAction("answered", "Enter")).toEqual({ kind: "grade", grade: "good" });
  });

  it("Backspace отменяет в любом рабочем состоянии", () => {
    expect(keyAction("question", "Backspace")).toEqual({ kind: "undo" });
    expect(keyAction("answered", "Backspace")).toEqual({ kind: "undo" });
    expect(keyAction("finished", "Backspace")).toEqual({ kind: "undo" });
  });

  it("прочие клавиши и прочие состояния игнорируются", () => {
    expect(keyAction("answered", "x")).toBeNull();
    expect(keyAction("loading", " ")).toBeNull();
    expect(keyAction("finished", "Enter")).toBeNull();
    expect(keyAction("empty", "1")).toBeNull();
    expect(keyAction("loading", "Backspace")).toBeNull();
    expect(keyAction("empty", "Backspace")).toBeNull();
  });

  it("одно нажатие даёт ровно одно действие", async () => {
    // Проверка того же свойства на живом контроллере: пробел, обработанный
    // один раз, не должен и раскрыть карточку, и оценить её.
    const controller = await makeController();
    const card = controller.state().card?.id;

    const action = keyAction(controller.state().phase, " ");
    expect(action).toEqual({ kind: "reveal" });
    controller.reveal();

    expect(controller.state().phase).toBe("answered");
    expect(controller.state().card?.id).toBe(card);
    expect(await db.reviews.count()).toBe(0);
  });
});

describe("оценка и запись", () => {
  it("записывает прогресс и журнал до перехода к следующей карточке", async () => {
    const controller = await makeController();
    const card = controller.state().card!;

    controller.reveal();
    await controller.grade("good");

    // К моменту, когда показана следующая карточка, ответ уже на диске.
    expect(controller.state().card?.id).not.toBe(card.id);
    const history = await cardHistory(db, card.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ grade: "good", stateBefore: "new" });
  });

  it("копит оценки для итогов занятия", async () => {
    const controller = await makeController();

    controller.reveal();
    await controller.grade("easy");
    controller.reveal();
    await controller.grade("again");

    // Счёт идёт по ответам, а не по карточкам: карточка после «не знал»
    // вернётся и будет оценена снова.
    expect(controller.state().tally).toMatchObject({ easy: 1, again: 1, good: 0, hard: 0 });
  });

  it("новое занятие начинает счёт заново", async () => {
    const controller = await makeController();
    controller.reveal();
    await controller.grade("good");
    expect(controller.state().tally.good).toBe(1);

    await controller.restart();
    expect(controller.state().tally).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it("оценка до раскрытия ответа игнорируется", async () => {
    const controller = await makeController();
    await controller.grade("good");

    expect(controller.state().phase).toBe("question");
    expect(await db.reviews.count()).toBe(0);
  });

  it("«снова» возвращает карточку в этом же заходе", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("again");

    expect(controller.state().card?.id).not.toBe(first);

    const seen: string[] = [];
    while (controller.state().phase === "question" && seen.length < 12) {
      seen.push(controller.state().card!.id);
      controller.reveal();
      await controller.grade("good");
    }
    expect(seen).toContain(first);
  });

  it("«плохо помню» тоже возвращает карточку в этом же заходе", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("hard");
    expect(controller.state().card?.id).not.toBe(first);
    expect(controller.state().session.repeats).toBe(1);

    const seen: string[] = [];
    while (controller.state().phase === "question" && seen.length < 12) {
      seen.push(controller.state().card!.id);
      controller.reveal();
      await controller.grade("good");
    }
    expect(seen).toContain(first);
  });

  it("доходит до конца очереди", async () => {
    const controller = await makeController();
    let guard = 0;
    while (controller.state().phase === "question" && guard < 20) {
      guard += 1;
      controller.reveal();
      await controller.grade("good");
    }

    expect(controller.state().phase).toBe("finished");
    expect(controller.state().session.completed).toBe(3);
    expect(await db.reviews.count()).toBe(3);
  });
});

describe("отмена оценки", () => {
  it("в начале занятия отменять нечего", async () => {
    const controller = await makeController();
    expect(controller.state().canUndo).toBe(false);

    await controller.undo();
    expect(controller.state().phase).toBe("question");
    expect(await db.reviews.count()).toBe(0);
  });

  it("возвращает ту же карточку с раскрытым ответом", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("good");
    expect(controller.state().card?.id).not.toBe(first);

    await controller.undo();
    const state = controller.state();
    expect(state.phase).toBe("answered");
    expect(state.card?.id).toBe(first);
    // Сроки на кнопках должны быть теми же, что и в первый раз: иначе
    // выбирать придётся вслепую.
    expect(state.intervals).not.toBeNull();
  });

  it("возвращает прогресс FSRS к прежнему состоянию", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("easy");
    expect(await db.progress.get(first)).toBeDefined();

    await controller.undo();
    // Карточку видели впервые — значит и прогресса быть не должно.
    expect(await db.progress.get(first)).toBeUndefined();
  });

  it("возвращает прогресс уже знакомой карточки, а не стирает его", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("good");
    const afterFirst = await db.progress.get(first);

    // Второй заход по той же карточке: теперь прогресс уже был.
    await controller.restart();
    let guard = 0;
    while (controller.state().card?.id !== first && guard < 20) {
      guard += 1;
      controller.reveal();
      await controller.grade("good");
    }
    controller.reveal();
    await controller.grade("again");
    await controller.undo();

    expect(await db.progress.get(first)).toEqual(afterFirst);
  });

  it("не стирает запись журнала, а помечает её отменённой", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("again");
    await controller.undo();

    const history = await cardHistory(db, first);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ grade: "again", undone: true });
  });

  it("возвращает очередь, а не только карточку", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;
    const before = controller.state().session;

    // «Не знал» ставит карточку обратно в очередь — отмена должна убрать и это.
    controller.reveal();
    await controller.grade("again");
    expect(controller.state().session.repeats).toBe(1);

    await controller.undo();
    expect(controller.state().session).toEqual(before);
    expect(controller.state().card?.id).toBe(first);
  });

  it("возвращает счёт оценок", async () => {
    const controller = await makeController();

    controller.reveal();
    await controller.grade("easy");
    await controller.undo();

    expect(controller.state().tally).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it("отменяет несколько оценок подряд", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("good");
    controller.reveal();
    await controller.grade("good");

    await controller.undo();
    await controller.undo();

    expect(controller.state().card?.id).toBe(first);
    expect(controller.state().canUndo).toBe(false);
    expect(controller.state().session.answered).toBe(0);
    expect(await db.progress.count()).toBe(0);
  });

  it("позволяет переставить оценку после отмены", async () => {
    const controller = await makeController();
    const first = controller.state().card!.id;

    controller.reveal();
    await controller.grade("again");
    await controller.undo();
    await controller.grade("easy");

    expect(controller.state().tally).toMatchObject({ again: 0, easy: 1 });
    // В журнале обе записи: отменённая и настоящая.
    const history = await cardHistory(db, first);
    expect(history.map((row) => [row.grade, row.undone ?? false])).toEqual([
      ["again", true],
      ["easy", false],
    ]);
  });

  it("работает с экрана итогов", async () => {
    const controller = await makeController();
    let guard = 0;
    while (controller.state().phase === "question" && guard < 20) {
      guard += 1;
      controller.reveal();
      await controller.grade("good");
    }
    expect(controller.state().phase).toBe("finished");

    await controller.undo();
    expect(controller.state().phase).toBe("answered");
    expect(controller.state().session.completed).toBe(2);
  });

  it("новое занятие обнуляет историю отмен", async () => {
    const controller = await makeController();
    controller.reveal();
    await controller.grade("good");
    expect(controller.state().canUndo).toBe(true);

    await controller.restart();
    expect(controller.state().canUndo).toBe(false);
  });
});

describe("подписка на состояние", () => {
  it("сообщает об изменениях и отписывается", async () => {
    const controller = await makeController();
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((state) => seen.push(state.phase));

    controller.reveal();
    expect(seen).toContain("answered");

    unsubscribe();
    const before = seen.length;
    controller.showHint();
    expect(seen).toHaveLength(before);
  });
});
