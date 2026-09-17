/**
 * Проверка введённого ответа.
 *
 * Требование берётся прямо из устройства данных: в кластере несколько
 * взаимозаменяемых партнёров, и засчитывать нужно любого. Карточка, которая
 * наказывает за верный по смыслу ответ, учит неправильному — это худшее, что
 * может делать тренажёр.
 *
 * Отдельно от «правильно» стоит «почти»: опечатка — не ошибка выбора слова.
 * Система не решает за учащегося, засчитывать ли её, а сообщает, что именно
 * произошло, и решение остаётся за интерфейсом.
 */

import { editDistance, sameWord } from "./lemma";
import type { AnswerCheck, AnswerReason } from "./types";

/** Артикли и указатели, из-за которых не стоит считать ответ неверным. */
const IGNORABLE = new Set([
  "a",
  "an",
  "the",
  "to",
  "your",
  "his",
  "her",
  "their",
  "my",
  "our",
  "its",
]);

/** Приводит ввод к виду, пригодному для сравнения. */
export function normalizeInput(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalizeInput(text).split(" ").filter(Boolean);
}

/** Убирает служебные слова, различие в которых не считается ошибкой. */
function meaningfulWords(list: string[]): string[] {
  const filtered = list.filter((word) => !IGNORABLE.has(word));
  // Если от записи ничего не осталось (сам ответ — артикль или предлог),
  // сравниваем как есть.
  return filtered.length > 0 ? filtered : list;
}

function compare(input: string[], candidate: string[]): AnswerReason | null {
  if (input.length === candidate.length) {
    if (input.every((word, index) => word === candidate[index])) return "exact";
    if (input.every((word, index) => sameWord(word, candidate[index] ?? ""))) {
      return "form";
    }
  }

  const inputCore = meaningfulWords(input);
  const candidateCore = meaningfulWords(candidate);
  if (
    inputCore.length === candidateCore.length &&
    inputCore.every((word, index) => sameWord(word, candidateCore[index] ?? ""))
  ) {
    return "article";
  }
  return null;
}

/** Похоже ли на опечатку: та же длина в словах и одна правка в сумме. */
function looksLikeTypo(input: string[], candidate: string[]): boolean {
  if (input.length !== candidate.length) return false;
  let budget = 1;
  for (let index = 0; index < input.length; index += 1) {
    const left = input[index] ?? "";
    const right = candidate[index] ?? "";
    if (left === right) continue;
    // На коротких словах «одна правка» — это уже другое слово:
    // `make` и `take` различаются одной буквой, но опечаткой это не назвать.
    if (Math.max(left.length, right.length) < 5) return false;
    budget -= editDistance(left, right, budget);
    if (budget < 0) return false;
  }
  return budget >= 0;
}

/** Чем точнее совпадение, тем меньше число: из нескольких берём лучшее. */
const REASON_PRIORITY: Record<AnswerReason, number> = {
  exact: 0,
  article: 1,
  form: 2,
  typo: 3,
};

export interface GradableCard {
  /** Форма, стоявшая в предложении. */
  answer: string;
  /** Все развёрнутые формы, которые засчитываются. */
  answers: string[];
}

/**
 * Проверяет ввод по всем допустимым формам карточки.
 *
 * Возвращает не только вердикт, но и то, с чем совпало и почему: интерфейсу
 * есть что показать — «правильно, но в предложении стояла другая форма» или
 * «похоже на опечатку».
 */
export function checkAnswer(input: string, card: GradableCard): AnswerCheck {
  const typed = words(input);
  if (typed.length === 0) {
    return { verdict: "wrong", matched: null, reason: null };
  }

  const candidates = [card.answer, ...card.answers];
  let best: { matched: string; reason: AnswerReason } | null = null;
  let nearMiss: string | null = null;

  for (const candidate of candidates) {
    const expected = words(candidate);
    if (expected.length === 0) continue;

    const reason = compare(typed, expected);
    if (reason !== null) {
      // Берём самое точное совпадение, а не первое встреченное: иначе на
      // карточке с `demonstrate` и `demonstrated` ввод «demonstrate» показал
      // бы совпадение с формой из предложения, хотя совпал он буквально.
      if (best === null || REASON_PRIORITY[reason] < REASON_PRIORITY[best.reason]) {
        best = { matched: candidate, reason };
      }
      if (reason === "exact") break;
      continue;
    }
    if (nearMiss === null && looksLikeTypo(typed, expected)) {
      nearMiss = candidate;
    }
  }

  if (best !== null) {
    return { verdict: "correct", matched: best.matched, reason: best.reason };
  }
  if (nearMiss !== null) {
    return { verdict: "almost", matched: nearMiss, reason: "typo" };
  }
  return { verdict: "wrong", matched: null, reason: null };
}
