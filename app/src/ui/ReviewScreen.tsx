/**
 * Экран повторения.
 *
 * Вёрстка здесь намеренно простая: это скелет с правильной структурой, а не
 * оформление. Дизайн придёт отдельно и заменит разметку, поэтому вся логика
 * занятия живёт в контроллере, а компонент только показывает его состояние и
 * пересылает нажатия.
 *
 * Пять состояний экрана: вопрос, верный ответ, неверный ответ, опечатка и
 * конец очереди. Все пять видны здесь и не требуют догадок при смене дизайна.
 */

import { useEffect, useRef, type FormEvent } from "react";

import { GRADES, type Grade } from "../srs";
import { suggestedGrade, type StudyController, type StudyState } from "../study/controller";
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Фокус возвращается в поле на каждой новой карточке: занятие идёт с
  // клавиатуры, и тянуться к мыши между карточками незачем.
  useEffect(() => {
    if (state.phase === "question") inputRef.current?.focus();
  }, [state.phase, state.card?.id]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (state.phase !== "answered" || state.saving) return;
      const index = ["1", "2", "3", "4"].indexOf(event.key);
      if (index >= 0) {
        event.preventDefault();
        void controller.grade(GRADES[index] as Grade);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void controller.grade(suggestedGrade(state.check));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller, state.phase, state.check, state.saving]);

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
  const verdict = state.check?.verdict ?? null;
  const [before, after] = card.text.split("___");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    controller.submit();
  }

  return (
    <section className="screen screen--review">
      <header className="progress muted">
        Осталось {state.session.remaining} из {state.counts.total}
      </header>

      <p className="sentence">
        {before}
        {answered ? (
          <mark className={`filled filled--${verdict ?? "revealed"}`}>{card.answer}</mark>
        ) : (
          <span className="gap">_____</span>
        )}
        {after}
      </p>

      {card.translation !== null && <p className="translation">{card.translation}</p>}

      {!answered && (
        <form onSubmit={onSubmit} className="answer-form">
          <input
            ref={inputRef}
            type="text"
            value={state.typed}
            onChange={(event) => controller.setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.submit();
              }
            }}
            placeholder="ваш вариант"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit">Проверить</button>
          <button type="button" onClick={() => controller.reveal()}>
            Не знаю
          </button>
          {state.hintVisible ? (
            <span className="hint">{card.hint}</span>
          ) : (
            <button type="button" onClick={() => controller.showHint()}>
              Подсказка
            </button>
          )}
        </form>
      )}

      {answered && (
        <div className="answer-block">
          {verdict === "correct" && state.check?.reason === "form" && (
            <p className="note-line">Верно. В предложении стояла форма «{card.answer}».</p>
          )}
          {verdict === "almost" && (
            <p className="note-line">
              Похоже на опечатку: вы набрали «{state.typed}», а нужно «
              {state.check?.matched}». Засчитать — решать вам.
            </p>
          )}
          {verdict === "wrong" && (
            <p className="note-line">Вы набрали «{state.typed}».</p>
          )}

          {card.note !== null && <p className="usage-note">{card.note}</p>}
          {card.also.length > 0 && (
            <p className="also muted">ещё варианты: {card.also.join(", ")}</p>
          )}

          <div className="grades">
            {GRADES.map((grade, index) => (
              <button
                key={grade}
                type="button"
                disabled={state.saving}
                className={grade === suggestedGrade(state.check) ? "suggested" : ""}
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
