/** Человеческие подписи для чисел, которые отдаёт ядро. */

/**
 * Срок до следующего показа.
 *
 * На кнопках оценки нужен не точный интервал, а порядок величины: «через
 * десять минут» против «через три дня» — это разные решения, а «через 2.7 дня»
 * не значит ничего.
 */
export function formatInterval(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "сейчас";

  const minutes = days * 24 * 60;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} мин`;
  if (days < 1) return `${Math.round(minutes / 60)} ч`;
  if (days < 30) return `${Math.round(days)} д`;
  if (days < 365) return `${Math.round(days / 30)} мес`;

  const years = days / 365;
  return years < 10 ? `${years.toFixed(1)} г` : `${Math.round(years)} г`;
}

const FORMS: Record<string, [string, string, string]> = {
  карточка: ["карточка", "карточки", "карточек"],
  новая: ["новая", "новые", "новых"],
  повторение: ["повторение", "повторения", "повторений"],
  осталось: ["осталась", "остались", "осталось"],
};

/** Согласование числительного: 1 карточка, 2 карточки, 5 карточек. */
export function plural(count: number, word: keyof typeof FORMS): string {
  const forms = FORMS[word];
  if (forms === undefined) return word;

  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
