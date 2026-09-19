/**
 * Меню действий над карточкой.
 *
 * Нужно потому, что карточка может оказаться негодной — в колоде есть
 * предложения, где пропуск не восстановим или английский неудачен, — а оценка
 * такую карточку не лечит: любая оценка означает «я её учу».
 *
 * Три действия отвечают на три разных вопроса, и их нельзя сводить к одному:
 *
 * - **приостановить** — карточка сломана, видеть её больше не хочу;
 * - **закопать** — карточка нормальная, но не сегодня;
 * - **сбросить** — расписание разъехалось с реальностью (например, промахнулся
 *   по «отлично помню», и карточка ушла на год вперёд).
 *
 * Меню прячется за тремя точками, а не разложено кнопками: это редкие
 * действия, и соседство с кнопками оценки кончилось бы промахами.
 */

import type { CardAction } from "../study/controller";
import { Dropdown } from "./Dropdown";

const ITEMS: { action: CardAction; label: string; hint: string }[] = [
  { action: "bury", label: "Отложить до завтра", hint: "карточка нормальная, но не сейчас" },
  { action: "suspend", label: "Убрать из оборота", hint: "карточка негодная" },
  { action: "reset", label: "Учить заново", hint: "сбросить расписание в «новая»" },
];

interface Props {
  disabled: boolean;
  onPick: (action: CardAction) => void;
}

export function CardMenu({ disabled, onPick }: Props) {
  return (
    <Dropdown title="Действия над карточкой" disabled={disabled}>
      {(close) => (
        <>
          {ITEMS.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                close();
                onPick(item.action);
              }}
            >
              <span className="menu-item-label">{item.label}</span>
              <span className="menu-item-hint">{item.hint}</span>
            </button>
          ))}
          <p className="menu-foot">Любое из этих действий отменяется кнопкой «Назад».</p>
        </>
      )}
    </Dropdown>
  );
}
