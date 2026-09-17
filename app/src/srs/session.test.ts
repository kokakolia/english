import { describe, expect, it } from "vitest";

import { createSession } from "./session";
import { makeDeck } from "./testing";

describe("сессия повторения", () => {
  it("идёт по карточкам в заданном порядке", () => {
    const cards = makeDeck(3, 3);
    const session = createSession(cards);

    expect(session.current()?.id).toBe(cards[0]?.id);
    session.answer("good");
    expect(session.current()?.id).toBe(cards[1]?.id);
    session.answer("easy");
    expect(session.current()?.id).toBe(cards[2]?.id);
    session.answer("good");
    expect(session.isFinished()).toBe(true);
    expect(session.current()).toBeNull();
  });

  it("возвращает карточку, на которой ошиблись", () => {
    const cards = makeDeck(6, 6);
    const session = createSession(cards, { againGap: 2 });
    const first = session.current();

    session.answer("again");
    // Не сразу же: иначе ответ будет угадан по свежей памяти, а не вспомнен.
    expect(session.current()?.id).not.toBe(first?.id);

    const seen: string[] = [];
    while (!session.isFinished() && seen.length < 20) {
      seen.push(session.current()?.id ?? "");
      session.answer("good");
    }
    expect(seen).toContain(first?.id);
  });

  it("возврат не теряется в конце длинной очереди", () => {
    const cards = makeDeck(30, 30);
    const session = createSession(cards, { againGap: 3 });
    const first = session.current();
    session.answer("again");

    const upcoming: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      upcoming.push(session.current()?.id ?? "");
      session.answer("good");
    }
    expect(upcoming).toContain(first?.id);
  });

  it("сессия заканчивается, даже если отступ больше остатка очереди", () => {
    const cards = makeDeck(2, 2);
    const session = createSession(cards, { againGap: 10 });
    session.answer("again");
    let guard = 0;
    while (!session.isFinished() && guard < 10) {
      session.answer("good");
      guard += 1;
    }
    expect(session.isFinished()).toBe(true);
  });

  it("считает ответы, закрытые карточки и возвраты отдельно", () => {
    const cards = makeDeck(3, 3);
    const session = createSession(cards, { againGap: 1 });

    session.answer("again");
    session.answer("good");
    session.answer("good");
    session.answer("good");

    expect(session.progress()).toMatchObject({
      answered: 4,
      completed: 3,
      repeats: 1,
      remaining: 0,
    });
  });

  it("по умолчанию не возвращает карточки, оценённые как трудные", () => {
    const cards = makeDeck(2, 2);
    const session = createSession(cards);
    session.answer("hard");
    session.answer("hard");
    expect(session.isFinished()).toBe(true);
  });

  it("возврат трудных включается настройкой", () => {
    const cards = makeDeck(2, 2);
    const session = createSession(cards, { repeatHard: true, againGap: 0 });
    session.answer("hard");
    expect(session.isFinished()).toBe(false);
    expect(session.progress().repeats).toBe(1);
  });

  it("ответ на пустой сессии ничего не ломает", () => {
    const session = createSession([]);
    expect(session.isFinished()).toBe(true);
    session.answer("good");
    expect(session.progress().answered).toBe(0);
  });
});
