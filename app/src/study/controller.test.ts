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
import { createStudyController, suggestedGrade, type StudyController } from "./controller";

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

/** Три карточки разных гнёзд с разными ответами. */
function sampleCards() {
  return [
    makeCard({
      id: "c_1",
      position: 1,
      headword: "decision",
      text: "We need to ___ a decision by Friday.",
      answer: "make",
      answers: ["make", "take", "reach"],
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

describe("ответ на карточку", () => {
  it("засчитывает любого партнёра кластера", async () => {
    const controller = await makeController();
    const card = controller.state().card!;
    const other = card.answers[1] ?? card.answer;

    controller.setTyped(other);
    controller.submit();

    expect(controller.state().phase).toBe("answered");
    expect(controller.state().check?.verdict).toBe("correct");
  });

  it("не принимает пустой ввод", async () => {
    const controller = await makeController();
    controller.setTyped("   ");
    controller.submit();
    expect(controller.state().phase).toBe("question");
  });

  it("опечатка по умолчанию не засчитывается", async () => {
    const controller = await makeController({ seed: 1 });
    // Ищем карточку с достаточно длинным ответом, чтобы опечатка имела смысл.
    while (controller.state().card!.answer.length < 6) {
      controller.reveal();
      await controller.grade("good");
    }
    const answer = controller.state().card!.answer;
    const typo = answer.slice(0, -2) + answer.slice(-1) + answer.slice(-2, -1);

    controller.setTyped(typo);
    controller.submit();
    expect(controller.state().check?.verdict).toBe("almost");
  });

  it("настройкой опечатку можно засчитывать", async () => {
    await updateStudySettings(db, { acceptTypos: true });
    const controller = await makeController();
    while (controller.state().card!.answer.length < 6) {
      controller.reveal();
      await controller.grade("good");
    }
    const answer = controller.state().card!.answer;
    const typo = answer.slice(0, -2) + answer.slice(-1) + answer.slice(-2, -1);

    controller.setTyped(typo);
    controller.submit();
    expect(controller.state().check?.verdict).toBe("correct");
    expect(controller.state().check?.reason).toBe("typo");
  });

  it("ответ можно раскрыть без попытки", async () => {
    const controller = await makeController();
    controller.reveal();

    expect(controller.state().phase).toBe("answered");
    // Вердикта нет: человек не отвечал, и называть это ошибкой неправильно —
    // оценку он поставит сам.
    expect(controller.state().check).toBeNull();
  });

  it("показывает сроки на кнопках до выбора оценки", async () => {
    const controller = await makeController();
    controller.reveal();

    const intervals = controller.state().intervals!;
    expect(intervals.again).toBeLessThanOrEqual(intervals.good);
    expect(intervals.good).toBeLessThan(intervals.easy);
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

describe("оценка и запись", () => {
  it("записывает прогресс и журнал до перехода к следующей карточке", async () => {
    const controller = await makeController();
    const card = controller.state().card!;

    controller.setTyped(card.answer);
    controller.submit();
    await controller.grade("good");

    // К моменту, когда показана следующая карточка, ответ уже на диске.
    expect(controller.state().card?.id).not.toBe(card.id);
    const history = await cardHistory(db, card.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      grade: "good",
      typed: card.answer,
      verdict: "correct",
    });
  });

  it("оценка до показа ответа игнорируется", async () => {
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

describe("подписка на состояние", () => {
  it("сообщает об изменениях и отписывается", async () => {
    const controller = await makeController();
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((state) => seen.push(state.phase));

    controller.reveal();
    expect(seen).toContain("answered");

    unsubscribe();
    const before = seen.length;
    controller.setTyped("x");
    expect(seen).toHaveLength(before);
  });
});

describe("предлагаемая оценка", () => {
  it("после верного ответа — «good», иначе «again»", () => {
    expect(suggestedGrade({ verdict: "correct", matched: "make", reason: "exact" })).toBe(
      "good",
    );
    expect(suggestedGrade({ verdict: "wrong", matched: null, reason: null })).toBe("again");
    expect(suggestedGrade(null)).toBe("again");
  });
});
