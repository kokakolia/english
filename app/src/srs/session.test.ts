import { describe, expect, it } from "vitest";
import { createSession, type SessionSnapshot } from "./session";
import { makeDeck } from "./testing";

const START = new Date("2026-10-31T10:00:00Z");
describe("занятие по расписанию", () => {
  function setup(count = 2) {
    let now = START;
    const cards = makeDeck(count, count);
    const session = createSession(cards, { clock: () => now });
    return {
      cards,
      session,
      at: (minutes: number) => {
        now = new Date(START.getTime() + minutes * 60_000);
      },
    };
  }
  it("проходит карточки без собственного правила повтора по оценке", () => {
    const { session } = setup();
    session.answer("hard");
    session.answer("again");
    expect(session.isFinished()).toBe(true);
  });
  it("не показывает последнюю карточку раньше срока", () => {
    const { session, cards, at } = setup(1);
    const due = new Date(START.getTime() + 60_000).toISOString();
    session.answer("again", due);
    expect(session.current()).toBeNull();
    expect(session.isFinished()).toBe(false);
    expect(session.nextDue()).toBe(due);
    session.answer("good");
    expect(session.progress().answered).toBe(1);
    at(1);
    expect(session.current()).toEqual(cards[0]);
    session.answer("good");
    expect(session.isFinished()).toBe(true);
  });
  it("показывает другие карточки во время ожидания", () => {
    const { session, cards } = setup();
    session.answer("good", new Date(START.getTime() + 600_000).toISOString());
    expect(session.current()).toEqual(cards[1]);
  });
  it("срок повтора не меняет карточку, которую пользователь уже видит", () => {
    const { session, cards, at } = setup(3);
    session.answer("again", new Date(START.getTime() + 60_000).toISOString());
    expect(session.current()).toEqual(cards[1]);
    at(2);
    session.answer("easy");
    expect(session.current()).toEqual(cards[0]);
    session.answer("easy");
    expect(session.current()).toEqual(cards[2]);
  });
  it("возвращает наступившие повторы по времени", () => {
    const { session, cards, at } = setup();
    session.answer("hard", new Date(START.getTime() + 300_000).toISOString());
    session.answer("again", new Date(START.getTime() + 60_000).toISOString());
    at(1);
    expect(session.current()).toEqual(cards[1]);
    session.answer("easy");
    at(5);
    expect(session.current()).toEqual(cards[0]);
  });
  it("считает только первую попытку в результате вспоминания", () => {
    const { session, at } = setup(1);
    session.answer("again", new Date(START.getTime() + 60_000).toISOString());
    at(1);
    session.answer("good");
    expect(session.progress()).toMatchObject({
      answered: 2,
      firstAnswered: 1,
      firstRecalled: 0,
      repeats: 1,
      completed: 1,
    });
  });
  it("hard считается успешным вспоминанием с первой попытки", () => {
    const { session } = setup(1);
    session.answer("hard");
    expect(session.progress().firstRecalled).toBe(1);
  });
  it("отмена восстанавливает ожидание, очередь и статистику", () => {
    const { session, at } = setup(1);
    session.answer("again", new Date(START.getTime() + 60_000).toISOString());
    const snapshot = session.snapshot();
    at(1);
    session.answer("easy");
    session.restore(snapshot);
    expect(session.progress()).toMatchObject({
      remaining: 1,
      answered: 1,
      firstRecalled: 0,
      repeats: 0,
      completed: 0,
    });
    expect(session.current()).not.toBeNull();
  });
  it("исключение карточки не засчитывает ответ; пустая сессия безопасна", () => {
    const { session } = setup(1);
    session.drop();
    session.answer("good");
    expect(session.isFinished()).toBe(true);
    expect(session.progress().answered).toBe(0);
    expect(session.progress().excluded).toBe(1);
  });

  it("тысяча отмен не хранит копии всей очереди и первых оценок", () => {
    const { session } = setup(1000);
    const snapshots: SessionSnapshot[] = [];
    for (let i = 0; i < 1000; i++) {
      session.current();
      snapshots.push(session.snapshot());
      session.answer("easy");
    }
    const nodes = new Set<unknown>();
    let change = session.snapshot().change;
    while (change) {
      expect(Object.values(change).some(Array.isArray)).toBe(false);
      nodes.add(change);
      change = change.parent;
    }
    expect(nodes.size).toBe(1000);
    for (const snapshot of snapshots)
      expect(Object.values(snapshot).some(Array.isArray)).toBe(false);
    for (let i = 999; i >= 0; i--) {
      session.restore(snapshots[i]!);
      expect(session.progress()).toMatchObject({
        remaining: 1000 - i,
        completed: i,
        answered: i,
        firstAnswered: i,
        firstRecalled: i,
      });
    }
  });

  it("отмена восстанавливает вставки повторов, исключения и первые оценки", () => {
    const { session, cards, at } = setup(3);
    const first = session.snapshot();
    session.answer("again", new Date(START.getTime() + 60_000).toISOString());
    const afterAnswer = session.snapshot();
    session.drop();
    const afterDrop = session.snapshot();
    session.answer("hard");
    at(1);
    session.answer("easy");
    session.restore(afterDrop);
    expect(session.current()).toEqual(cards[0]); // наступивший повтор имеет приоритет
    expect(session.progress()).toMatchObject({
      excluded: 1,
      answered: 1,
      completed: 0,
      firstRecalled: 0,
    });
    session.restore(afterAnswer);
    expect(session.progress().excluded).toBe(0);
    session.restore(first);
    expect(session.current()).toEqual(cards[0]);
    expect(session.progress()).toMatchObject({
      answered: 0,
      excluded: 0,
      firstAnswered: 0,
      remaining: 3,
    });
  });

  it("чужие снимки и отменённые ветки не меняют состояние", () => {
    const { session } = setup(2),
      before = session.snapshot();
    session.answer("good");
    const branch = session.snapshot();
    session.restore(before);
    session.answer("hard");
    const progress = session.progress();
    expect(() => session.restore(branch)).toThrow(/ветка/i);
    expect(() => session.restore(setup().session.snapshot())).toThrow(
      /другому/,
    );
    expect(session.progress()).toEqual(progress);
  });

  it("девять ошибок не создают ни одной завершённой карточки", () => {
    const { session, at } = setup(1);
    for (let minute = 1; minute <= 9; minute++) {
      session.answer(
        "again",
        new Date(START.getTime() + minute * 60_000).toISOString(),
      );
      at(minute);
    }
    expect(session.progress()).toMatchObject({
      answered: 9,
      completed: 0,
      remaining: 1,
      firstRecalled: 0,
    });
  });

  it("неверный срок отклоняется до изменения очереди и статистики", () => {
    const { session, cards } = setup(1),
      before = session.progress();
    expect(() => session.answer("again", "invalid")).toThrow();
    expect(session.progress()).toEqual(before);
    expect(session.current()).toEqual(cards[0]);
  });
});
