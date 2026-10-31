import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReviewScreen } from "./ReviewScreen";
import { DayScreen } from "./DayScreen";
import type { StudyController, StudyState } from "../study/controller";

it("итоги называют первую попытку и дополнительные ответы отдельно", () => {
  const state: StudyState = {
    phase: "waiting",
    card: null,
    hintVisible: false,
    tally: { again: 1, hard: 0, good: 1, easy: 0 },
    counts: { fresh: 1, learning: 0, review: 0, total: 1 },
    backlog: 0,
    canUndo: false,
    saving: false,
    error: null,
    nextReviewAt: "2026-10-31T10:10:00Z",
    session: {
      remaining: 1,
      answered: 2,
      completed: 0,
      repeats: 1,
      firstAnswered: 1,
      firstRecalled: 0,
    },
  };
  const html = renderToStaticMarkup(
    <ReviewScreen
      controller={{} as StudyController}
      state={state}
      onFinish={() => {}}
    />,
  );
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("с первой попытки вспомнили 0 из 1 (0%)");
  expect(text).toContain("Дополнительных попыток: 1");
  expect(text).toContain("Время для перерыва");
  expect(text).not.toContain("Занятие завершено");
});

it("экран дня не объявляет день завершённым при будущем повторении", () => {
  const html = renderToStaticMarkup(
    <DayScreen
      deckName="Test"
      counts={{
        total: 1,
        fresh: 0,
        due: 0,
        learning: 1,
        review: 0,
        backlog: 0,
        nextReviewAt: "2026-10-31T10:10:00Z",
      }}
      backlog={0}
      offline={false}
      onStart={() => {}}
    />,
  );
  expect(html).toContain("Ближайшее повторение:");
  expect(html).toContain("Сейчас карточек нет");
  expect(html).not.toContain("На сегодня всё");
});
