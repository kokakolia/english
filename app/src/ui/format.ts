/** Человеческие подписи для чисел, которые отдаёт ядро. */

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
