/**
 * Выпадающее меню за тремя точками.
 *
 * Общая часть для меню карточки и меню экрана дня. Вынесено не ради экономии
 * строк, а ради поведения: закрытие по клику мимо и по Escape легко забыть во
 * второй копии, и тогда меню остаётся висеть над следующим экраном и ловит
 * нажатие, предназначенное не ему.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { DotsIcon } from "./Ornaments";

interface Props {
  title: string;
  disabled?: boolean;
  /**
   * Показать метку на кнопке: внутри есть что-то, о чём стоит знать.
   * Тихая точка вместо предупреждения на пол-экрана.
   */
  marked?: boolean;
  /** Сохраняет состояние долгой операции при закрытии меню. */
  keepMounted?: boolean;
  /** Содержимое. Получает функцию закрытия: пункт закрывает меню за собой. */
  children: (close: () => void) => ReactNode;
}

export function Dropdown({ title, disabled = false, marked = false, keepMounted = false, children }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onDown(event: MouseEvent) {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Нажатие не идёт дальше: тем же Escape закрывается занятие, и без
      // остановки одно нажатие закрыло бы и меню, и занятие разом. Обработчик
      // занятия висит на window, этот — на document, и document в пути
      // всплытия раньше.
      event.stopPropagation();
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
        className={marked ? "menu-button menu-button--marked" : "menu-button"}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
      >
        <DotsIcon />
      </button>

      {(open || keepMounted) && (
        <div className="menu-list" role={open ? "menu" : undefined} hidden={!open} style={open ? undefined : { display: "none" }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
