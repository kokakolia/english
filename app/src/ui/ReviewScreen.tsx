/**
 * Экран повторения.
 *
 * Вёрстка здесь намеренно простая: это скелет с правильной структурой, а не
 * оформление. Дизайн придёт отдельно и заменит разметку, поэтому вся логика
 * занятия живёт в контроллере, а компонент только показывает его состояние и
 * пересылает нажатия.
 *
 * Проверяет себя учащийся: система показывает пропуск, по требованию
 * раскрывает карточку и принимает оценку. Поля ввода нет.
 */

import { useEffect } from "react";

import { GRADES, type Grade } from "../srs";
import { keyAction, type StudyController, type StudyState } from "../study/controller";
import { formatInterval } from "./format";

const GRADE_LABELS: Record<Grade, string> = {
  again: "Снова",
  hard: "Трудно",
  good: "Хорошо",
  easy: "Легко",
};

interface Props {
  controller: StudyController;
  state: StudyState;
  onFinish: () => void;
}

export function ReviewScreen({ controller, state, onFinish }: Props) {
  // Обработчик вешается один раз за всё занятие и спрашивает состояние сам.
  // Если перевешивать его на каждую смену состояния, одно нажатие Enter
  // успевает и раскрыть карточку, и оценить её: React перерисовывает экран
  // внутри того же события, а обработчик, добавленный на цель, до которой
  // событие ещё не дошло, по спецификации DOM всё равно срабатывает.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const current = controller.state();
      if (current.saving) return;

      const action = keyAction(current.phase, event.key);
      if (action === null) return;

      event.preventDefault();
      if (action.kind === "reveal") controller.reveal();
      else void controller.grade(action.grade);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller]);

  if (state.phase === "finished" || state.phase === "empty") {
    return (
      <section className="screen screen--done">
        <h1>{state.phase === "empty" ? "На сегодня всё" : "Очередь пройдена"}</h1>
        {state.session.answered > 0 && (
          <p className="muted">
            Ответов: {state.session.answered}, карточек закрыто:{" "}
            {state.session.completed}
            {state.session.repeats > 0 && `, возвратов: ${state.session.repeats}`}
          </p>
        )}
        <button type="button" onClick={onFinish}>
          К началу
        </button>
      </section>
    );
  }

  const card = state.card;
  if (card === null) return <section className="screen">Загрузка…</section>;

  const answered = state.phase === "answered";
  const [before, after] = card.text.split("___");

  return (
    <section className="screen screen--review">
      <header className="progress muted">
        Осталось {state.session.remaining} из {state.counts.total}
      </header>

      <p className="sentence">
        {before}
        {answered ? (
          <mark className="filled">{card.answer}</mark>
        ) : (
          <span className="gap">_____</span>
        )}
        {after}
      </p>

      {card.translation !== null && <p className="translation">{card.translation}</p>}

      {!answered && (
        <div className="reveal-row">
          <button type="button" className="suggested" onClick={() => controller.reveal()}>
            Показать ответ
            <span className="grade-key muted">пробел</span>
          </button>
          {state.hintVisible ? (
            <span className="hint">{card.hint}</span>
          ) : (
            <button type="button" onClick={() => controller.showHint()}>
              Подсказка
            </button>
          )}
        </div>
      )}

      {answered && (
        <div className="answer-block">
          {card.note !== null && <p className="usage-note">{card.note}</p>}
          {card.also.length > 0 && (
            <p className="also muted">
              так же подошло бы: {card.also.join(", ")}
            </p>
          )}

          <div className="grades">
            {GRADES.map((grade, index) => (
              <button
                key={grade}
                type="button"
                disabled={state.saving}
                className={grade === "good" ? "suggested" : ""}
                onClick={() => void controller.grade(grade)}
              >
                <span className="grade-label">{GRADE_LABELS[grade]}</span>
                <span className="grade-interval muted">
                  {state.intervals ? formatInterval(state.intervals[grade]) : ""}
                </span>
                <span className="grade-key muted">{index + 1}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {state.error !== null && <p className="error">{state.error}</p>}
    </section>
  );
}
