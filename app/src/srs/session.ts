/**
 * Сессия повторения: порядок карточек внутри одного захода.
 *
 * Очередь дня отвечает на вопрос «что показать сегодня», сессия — на вопрос
 * «что показать прямо сейчас». Разница существенна: карточку, на которой
 * учащийся ошибся, нужно вернуть в этом же заходе, а не через сутки. Иначе
 * ошибка не исправляется, а просто откладывается.
 *
 * Сессия сознательно ничего не знает про планировщик и хранилище: она
 * распоряжается только порядком. Применить оценку и записать её в журнал —
 * дело вызывающего кода. Благодаря этому её поведение проверяется без часов,
 * базы и моков.
 */

import type { DeckCard, Grade } from "./types";

export interface SessionOptions {
  /**
   * Через сколько других карточек вернуть ту, на которой ошиблись.
   * Ноль вернёт её сразу же, и она будет угадана по свежей памяти, а не
   * вспомнена.
   */
  againGap?: number;
  /**
   * Возвращать ли карточки, оценённые как `hard`. По умолчанию нет: ответ был
   * верным, просто дался тяжело, и планировщик уже назначил короткий интервал.
   */
  repeatHard?: boolean;
}

export interface SessionProgress {
  /** Сколько карточек ещё покажут, включая возвраты. */
  remaining: number;
  /** Сколько ответов дано, включая повторные показы одной карточки. */
  answered: number;
  /** Сколько карточек закрыто окончательно. */
  completed: number;
  /** Сколько раз пришлось возвращать карточки. */
  repeats: number;
}

export interface Session {
  /** Текущая карточка или `null`, если сессия закончена. */
  current(): DeckCard | null;
  /** Оценить текущую карточку и перейти к следующей. */
  answer(grade: Grade): void;
  progress(): SessionProgress;
  isFinished(): boolean;
}

const DEFAULT_AGAIN_GAP = 3;

export function createSession(
  cards: readonly DeckCard[],
  options: SessionOptions = {},
): Session {
  const againGap = options.againGap ?? DEFAULT_AGAIN_GAP;
  const repeatHard = options.repeatHard ?? false;

  const queue: DeckCard[] = cards.slice();
  let answered = 0;
  let completed = 0;
  let repeats = 0;

  function shouldRepeat(grade: Grade): boolean {
    if (grade === "again") return true;
    return repeatHard && grade === "hard";
  }

  return {
    current() {
      return queue[0] ?? null;
    },

    answer(grade) {
      const card = queue.shift();
      if (card === undefined) return;

      answered += 1;
      if (shouldRepeat(grade)) {
        repeats += 1;
        // Ставим не в конец, а через несколько карточек: в конце длинной
        // очереди возврат превратится в новое знакомство, а не в повторную
        // попытку. Если очередь короче отступа, карточка встанет в конец.
        const position = Math.min(againGap, queue.length);
        queue.splice(position, 0, card);
      } else {
        completed += 1;
      }
    },

    progress() {
      return { remaining: queue.length, answered, completed, repeats };
    },

    isFinished() {
      return queue.length === 0;
    },
  };
}
