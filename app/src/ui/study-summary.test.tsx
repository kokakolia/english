import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReviewScreen } from "./ReviewScreen";
import { DayScreen } from "./DayScreen";
import type { StudyController, StudyState } from "../study/controller";
import { makeCard } from "../srs/testing";

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
      excluded: 0,
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
  const question = {
    ...state,
    phase: "question" as const,
    card: makeCard(),
    session: { ...state.session, answered: 9 },
  };
  const progress = renderToStaticMarkup(
    <ReviewScreen
      controller={{} as StudyController}
      state={question}
      onFinish={() => {}}
    />,
  );
  expect(progress).toContain('aria-valuenow="0"');
  expect(progress).toContain('aria-valuemax="1"');
  expect(progress.replace(/<[^>]*>/g, "")).toContain("0 готово · 1 осталось");
  const almostDone = {
    ...question,
    session: { ...question.session, completed: 15, remaining: 1 },
  };
  const almost = renderToStaticMarkup(
    <ReviewScreen
      controller={{} as StudyController}
      state={almostDone}
      onFinish={() => {}}
    />,
  );
  expect(almost).toContain('class="dot dot--empty"');
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
  expect(html).toContain("Следующие карточки доступны:");
  expect(html).toContain("Сейчас карточек нет");
  expect(html).not.toContain("На сегодня всё");
});
