/** Вспомогательные построители для тестов ядра. */

import type { DeckCard } from "./types";

let counter = 0;

export function makeCard(overrides: Partial<DeckCard> = {}): DeckCard {
  counter += 1;
  const id = overrides.id ?? `c_${counter.toString(16).padStart(16, "0")}`;
  return {
    id,
    type: "cloze",
    text: "We need to ___ a decision by Friday.",
    answer: "make",
    accept: ["make"],
    answers: ["make"],
    hint: "m___",
    translation: "Нам нужно принять решение до пятницы.",
    also: [],
    note: null,
    phrase: "make decision",
    relation: "verb+obj",
    headword: "decision",
    sense: null,
    cefr: null,
    band: "core",
    ambiguity: "low",
    flags: [],
    position: counter,
    ...overrides,
  };
}

/**
 * Набор карточек, распределённый по гнёздам.
 *
 * `families` задаёт, сколько разных заголовочных слов участвует: именно они
 * проверяются на разведение сиблингов.
 */
export function makeDeck(count: number, families = 4): DeckCard[] {
  return Array.from({ length: count }, (_, index) =>
    makeCard({
      id: `c_${index.toString(16).padStart(16, "0")}`,
      headword: `word${index % families}`,
      position: index + 1,
    }),
  );
}
