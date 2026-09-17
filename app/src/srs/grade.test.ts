import { describe, expect, it } from "vitest";

import { checkAnswer, normalizeInput } from "./grade";
import { comparableForm, editDistance, sameWord } from "./lemma";

describe("нормализация ввода", () => {
  it("снимает регистр, пунктуацию и лишние пробелы", () => {
    expect(normalizeInput("  Make,  A   Decision! ")).toBe("make a decision");
  });

  it("приводит типографский апостроф к обычному", () => {
    expect(normalizeInput("don’t")).toBe("don't");
  });
});

describe("сопоставление словоформ", () => {
  it("узнаёт неправильные глаголы", () => {
    expect(sameWord("get", "got")).toBe(true);
    expect(sameWord("come", "came")).toBe(true);
    expect(sameWord("see", "saw")).toBe(true);
    expect(sameWord("think", "thought")).toBe(true);
  });

  it("узнаёт правильные окончания", () => {
    expect(sameWord("demonstrate", "demonstrated")).toBe(true);
    expect(sameWord("stop", "stopped")).toBe(true);
    expect(sameWord("study", "studies")).toBe(true);
    expect(sameWord("live", "lived")).toBe(true);
  });

  it("не путает разные слова", () => {
    expect(sameWord("make", "take")).toBe(false);
    expect(sameWord("good", "food")).toBe(false);
    // Короткая общая основа не повод считать слова родственными.
    expect(sameWord("be", "bee")).toBe(false);
  });

  it("основа для сравнения не предъявляется пользователю", () => {
    // Она не обязана быть словарной формой — только устойчивой.
    expect(comparableForm("demonstrated")).toBe(comparableForm("demonstrate"));
  });
});

describe("расстояние правки", () => {
  it("считает замену, вставку и перестановку", () => {
    expect(editDistance("decision", "devision")).toBe(1);
    expect(editDistance("decision", "decison")).toBe(1);
    expect(editDistance("thing", "thign")).toBe(1);
    expect(editDistance("make", "makes")).toBe(1);
  });

  it("обрывается за порогом", () => {
    expect(editDistance("make", "completely", 2)).toBeGreaterThan(2);
  });
});

describe("проверка ответа", () => {
  const card = {
    answer: "demonstrated",
    answers: ["demonstrate", "prove", "show", "suggest", "demonstrated"],
  };

  it("засчитывает форму из предложения", () => {
    expect(checkAnswer("demonstrated", card)).toMatchObject({
      verdict: "correct",
      reason: "exact",
    });
  });

  it("засчитывает словарную форму", () => {
    const result = checkAnswer("demonstrate", card);
    expect(result.verdict).toBe("correct");
    expect(result.matched).toBe("demonstrate");
  });

  it("засчитывает другого партнёра кластера", () => {
    // Всё в кластере взаимозаменяемо — наказывать за это нельзя.
    expect(checkAnswer("showed", card).verdict).toBe("correct");
    expect(checkAnswer("proved", card).verdict).toBe("correct");
  });

  it("не придирается к регистру и пробелам", () => {
    expect(checkAnswer("  SHOW  ", card).verdict).toBe("correct");
  });

  it("отличает опечатку от неверного слова", () => {
    expect(checkAnswer("demonstarted", card)).toMatchObject({
      verdict: "almost",
      reason: "typo",
    });
    expect(checkAnswer("confirmed", card).verdict).toBe("wrong");
  });

  it("на коротком слове одна буква — уже другое слово", () => {
    // `make` против `take` отличается одной правкой, но это не опечатка.
    const short = { answer: "make", answers: ["make"] };
    expect(checkAnswer("take", short).verdict).toBe("wrong");
  });

  it("пустой ввод не засчитывается", () => {
    expect(checkAnswer("   ", card).verdict).toBe("wrong");
  });

  it("прощает артикль", () => {
    const phrase = { answer: "come to a decision", answers: ["come to a decision"] };
    expect(checkAnswer("come to decision", phrase)).toMatchObject({
      verdict: "correct",
      reason: "article",
    });
  });

  it("работает с многословными ответами", () => {
    const multi = { answer: "comes in", answers: ["come in", "comes in"] };
    expect(checkAnswer("come in", multi).verdict).toBe("correct");
    expect(checkAnswer("comes in", multi).verdict).toBe("correct");
    expect(checkAnswer("comes", multi).verdict).toBe("wrong");
  });

  it("ответ-артикль сравнивается как есть", () => {
    // Если сам ответ — служебное слово, отбрасывать его нельзя.
    const article = { answer: "the", answers: ["the", "a"] };
    expect(checkAnswer("the", article).verdict).toBe("correct");
    expect(checkAnswer("some", article).verdict).toBe("wrong");
  });
});
