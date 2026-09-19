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

import { useEffect, useRef, useState } from "react";

import type { CardAction } from "../study/controller";
import { DotsIcon } from "./Ornaments";

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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Закрытие по клику мимо и по Escape. Без этого меню остаётся висеть над
  // следующей карточкой и ловит нажатие, предназначенное оценке.
  useEffect(() => {
    if (!open) return;

    function onDown(event: MouseEvent) {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="menu-button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Действия над карточкой"
      >
        <DotsIcon />
      </button>

      {open && (
        <div className="menu-list" role="menu">
          {ITEMS.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onPick(item.action);
              }}
            >
              <span className="menu-item-label">{item.label}</span>
              <span className="menu-item-hint">{item.hint}</span>
            </button>
          ))}
          <p className="menu-foot">Любое из этих действий отменяется кнопкой «Назад».</p>
        </div>
      )}
    </div>
  );
}
