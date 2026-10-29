/**
 * Какая тема сейчас — для компонентов, которые рисуют, а не красят.
 *
 * Цвета решаются переменными CSS и контекста не требуют. Но значки оценок в
 * двух темах разные **фигурами**: в светлой это росток от увядшего к
 * цветущему, в тёмной — огонёк от погасшего к яркому. Росток на морском дне
 * не читается, а огонёк в саду не значит ничего.
 *
 * Контекст, а не проброс свойством: значок лежит на четыре уровня ниже места,
 * где тема известна, и тащить признак через все промежуточные компоненты
 * значит связать их с тем, до чего им нет дела.
 */

import { createContext, useContext, type ReactNode } from "react";

const DarkContext = createContext(false);

export function DarkProvider({
  dark,
  children,
}: {
  dark: boolean;
  children: ReactNode;
}) {
  return <DarkContext.Provider value={dark}>{children}</DarkContext.Provider>;
}

export function useDark(): boolean {
  return useContext(DarkContext);
}
