/**
 * Выбор темы.
 *
 * Три состояния, а не два: «как в системе», «светлая», «тёмная». Без первого
 * приложение навсегда застревает в том, что человек выбрал однажды, и перестаёт
 * следовать вечернему переключению системы. Без остальных двух нельзя сказать
 * «в системе тёмная, но это приложение хочу светлым» — законное желание.
 *
 * Хранится в localStorage, а не в базе. Причина не в лени: тема должна быть
 * известна **до первой отрисовки**, иначе экран моргнёт светлым и перекрасится.
 * localStorage читается синхронно, IndexedDB — нет.
 */

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "theme";

/** Что выбрано. Незнакомое значение считается «как в системе». */
export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Приватное окно или запрет на хранение: не повод падать.
    return "system";
  }
}

/** Применяет выбор к документу. Без атрибута решает системная настройка. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // То же: не сохранилось — проживём, просто не запомнится.
  }
}

/** Тёмная ли тема прямо сейчас — с учётом и выбора, и системы. */
export function isDarkNow(choice: ThemeChoice): boolean {
  if (choice === "dark") return true;
  if (choice === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
