/**
 * Сопоставление словоформ при проверке ответа.
 *
 * В колоде рядом лежат словарная форма (`demonstrate`) и та, что стояла в
 * предложении (`demonstrated`). Учащийся может набрать любую из них: мы
 * проверяем выбор слова, а не умение поставить его в нужное время. Поэтому
 * нужно уметь опознавать, что две формы принадлежат одному слову.
 *
 * Полноценной морфологии здесь нет намеренно: задача не разобрать текст, а
 * сравнить два коротких слова, которые почти наверняка родственны. Хватает
 * таблицы неправильных глаголов и отсечения регулярных окончаний.
 */

/** Неправильные глаголы и существительные: форма → начальная форма. */
const IRREGULAR_FORMS: Record<string, string> = {};

const IRREGULAR_GROUPS: readonly (readonly string[])[] = [
  ["be", "am", "is", "are", "was", "were", "been", "being"],
  ["become", "became"],
  ["begin", "began", "begun"],
  ["break", "broke", "broken"],
  ["bring", "brought"],
  ["build", "built"],
  ["buy", "bought"],
  ["catch", "caught"],
  ["choose", "chose", "chosen"],
  ["come", "came"],
  ["cost"],
  ["cut"],
  ["deal", "dealt"],
  ["do", "does", "did", "done"],
  ["draw", "drew", "drawn"],
  ["drink", "drank", "drunk"],
  ["drive", "drove", "driven"],
  ["eat", "ate", "eaten"],
  ["fall", "fell", "fallen"],
  ["feed", "fed"],
  ["feel", "felt"],
  ["fight", "fought"],
  ["find", "found"],
  ["fly", "flew", "flown"],
  ["forget", "forgot", "forgotten"],
  ["freeze", "froze", "frozen"],
  ["get", "got", "gotten"],
  ["give", "gave", "given"],
  ["go", "goes", "went", "gone"],
  ["grow", "grew", "grown"],
  ["hang", "hung"],
  ["have", "has", "had"],
  ["hear", "heard"],
  ["hide", "hid", "hidden"],
  ["hit"],
  ["hold", "held"],
  ["hurt"],
  ["keep", "kept"],
  ["know", "knew", "known"],
  ["lay", "laid"],
  ["lead", "led"],
  ["learn", "learnt"],
  ["leave", "left"],
  ["lend", "lent"],
  ["let"],
  ["lie", "lay", "lain"],
  ["lose", "lost"],
  ["make", "made"],
  ["mean", "meant"],
  ["meet", "met"],
  ["pay", "paid"],
  ["put"],
  ["read"],
  ["ride", "rode", "ridden"],
  ["ring", "rang", "rung"],
  ["rise", "rose", "risen"],
  ["run", "ran"],
  ["say", "said"],
  ["see", "saw", "seen"],
  ["seek", "sought"],
  ["sell", "sold"],
  ["send", "sent"],
  ["set"],
  ["shake", "shook", "shaken"],
  ["shoot", "shot"],
  ["show", "shown"],
  ["shut"],
  ["sing", "sang", "sung"],
  ["sit", "sat"],
  ["sleep", "slept"],
  ["speak", "spoke", "spoken"],
  ["spend", "spent"],
  ["spread"],
  ["stand", "stood"],
  ["steal", "stole", "stolen"],
  ["stick", "stuck"],
  ["strike", "struck"],
  ["swim", "swam", "swum"],
  ["take", "took", "taken"],
  ["teach", "taught"],
  ["tear", "tore", "torn"],
  ["tell", "told"],
  ["think", "thought"],
  ["throw", "threw", "thrown"],
  ["understand", "understood"],
  ["wake", "woke", "woken"],
  ["wear", "wore", "worn"],
  ["win", "won"],
  ["write", "wrote", "written"],
  // Существительные и степени сравнения.
  ["child", "children"],
  ["foot", "feet"],
  ["good", "better", "best"],
  ["bad", "worse", "worst"],
  ["man", "men"],
  ["many", "more", "most"],
  ["much"],
  ["person", "people"],
  ["tooth", "teeth"],
  ["woman", "women"],
  ["life", "lives"],
  ["knife", "knives"],
  ["wife", "wives"],
  ["leaf", "leaves"],
  ["half", "halves"],
  ["thief", "thieves"],
];

for (const group of IRREGULAR_GROUPS) {
  const base = group[0];
  if (base === undefined) continue;
  for (const form of group) {
    // `lay` — и прошедшее от `lie`, и самостоятельный глагол. Первая
    // встреченная база выигрывает: сравнение всё равно идёт в обе стороны.
    if (!(form in IRREGULAR_FORMS)) IRREGULAR_FORMS[form] = base;
  }
}

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** Отсекает регулярное окончание: `demonstrated` → `demonstrat`. */
function stripSuffix(word: string): string {
  const cut = (suffix: string, keep: number) =>
    word.length >= suffix.length + keep ? word.slice(0, -suffix.length) : word;

  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ied") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ing")) return cut("ing", 2);
  if (word.endsWith("ed")) return cut("ed", 2);
  if (word.endsWith("es") && word.length > 3) return cut("es", 2);
  if (word.endsWith("s") && !word.endsWith("ss")) return cut("s", 2);
  return word;
}

/**
 * Приводит слово к форме, по которой его можно сравнить с другим.
 *
 * Это не лемма в лингвистическом смысле: `demonstrate` и `demonstrated` дают
 * `demonstrat`, чего в словаре нет. Для сравнения этого достаточно, а для
 * показа пользователю результат никогда не используется.
 */
export function comparableForm(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_FORMS[lower];
  if (irregular !== undefined) return irregular;

  let stem = stripSuffix(lower);
  // Удвоенная согласная: stopped → stopp → stop.
  if (
    stem.length > 2 &&
    stem[stem.length - 1] === stem[stem.length - 2] &&
    !VOWELS.has(stem[stem.length - 1] ?? "")
  ) {
    stem = stem.slice(0, -1);
  }
  // Немая `e`: `lived` → `liv`, а словарная форма `live` → `liv`.
  // На коротких словах не трогаем: иначе `bee` сведётся к `be`.
  if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1);
  return stem;
}

/** Одно ли это слово в разных формах. */
export function sameWord(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return true;
  const baseA = IRREGULAR_FORMS[a];
  const baseB = IRREGULAR_FORMS[b];
  if (baseA !== undefined && baseA === b) return true;
  if (baseB !== undefined && baseB === a) return true;
  if (baseA !== undefined && baseA === baseB) return true;
  return comparableForm(a) === comparableForm(b);
}

/**
 * Расстояние Дамерау — Левенштейна, обрезанное сверху.
 *
 * Считается только для распознавания опечатки, поэтому дальше порога нам
 * неинтересно и вычисление обрывается.
 */
export function editDistance(left: string, right: string, limit = 2): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;

  const previous: number[] = Array.from({ length: right.length + 1 }, (_, i) => i);
  let beforePrevious: number[] = [];

  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      // Перестановка соседних букв: `teh` вместо `the`.
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, (beforePrevious[j - 2] ?? 0) + 1);
      }
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    beforePrevious = previous.slice();
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[right.length] ?? limit + 1;
}
