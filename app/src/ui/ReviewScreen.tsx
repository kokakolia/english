/**
 * Экран повторения по макету из `design/`.
 *
 * Три состояния: пропуск скрыт, ответ раскрыт, отклик после оценки. Логика
 * занятия здесь не живёт — компонент показывает состояние контроллера и
 * пересылает нажатия.
 */

import { useEffect } from "react";

import { GRADES, type Grade } from "../srs";
import { keyAction, type StudyController, type StudyState } from "../study/controller";
import { formatInterval } from "./format";
import { GradeIcon, Leaf, MoodPlant, PanelFlourish } from "./Ornaments";

/**
 * Подписи оценок из макета.
 *
 * Они описывают состояние памяти, а не действие системы: человек оценивает,
 * насколько вспомнил, и «не знал» об этом говорит понятнее, чем «снова».
 */
const GRADE_LABELS: Record<Grade, string> = {
  again: "Не знал",
  hard: "Плохо помню",
  good: "Помню",
  easy: "Отлично помню",
};

/** Оценки делятся надвое: одни возвращают карточку скоро, другие откладывают. */
const GRADE_MOOD: Record<Grade, "weak" | "strong"> = {
  again: "weak",
  hard: "weak",
  good: "strong",
  easy: "strong",
};

/** Сколько точек в полосе прогресса. Больше не помещается на телефоне. */
const DOT_COUNT = 8;

interface Props {
  controller: StudyController;
  state: StudyState;
  onFinish: () => void;
}

function ProgressHeader({ state }: { state: StudyState }) {
  const total = Math.max(1, state.session.remaining + state.session.answered);
  const done = state.session.answered;
  // Точки — грубая полоса прогресса: карточек за день бывает и полторы сотни,
  // и рисовать их поштучно бессмысленно. Точные числа рядом, в счётчике.
  const filled = Math.min(DOT_COUNT, Math.round((done / total) * DOT_COUNT));

  return (
    <>
      <div className="head">
        <div className="dots">
          {Array.from({ length: DOT_COUNT }, (_, index) => (
            <span key={index} className={index < filled ? "dot" : "dot dot--empty"} />
          ))}
        </div>
        <div className="counter">
          <Leaf className="counter-leaf" />
          <span className="counter-text">
            {done}&nbsp;/&nbsp;{total}
          </span>
          <Leaf className="counter-leaf counter-leaf--flip" />
        </div>
      </div>
      <div className="rule">
        <span className="rule-line" />
        <span className="rule-dot" />
        <span className="rule-line rule-line--rev" />
      </div>
    </>
  );
}

export function ReviewScreen({ controller, state, onFinish }: Props) {
  // Обработчик вешается один раз за занятие и спрашивает состояние сам.
  // Если перевешивать его на каждую смену состояния, одно нажатие успевает
  // сделать два шага: React перерисовывает экран внутри того же события, а
  // обработчик, добавленный на цель, до которой событие ещё не дошло, по
  // спецификации DOM всё равно срабатывает.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const current = controller.state();
      if (current.saving) return;

      const action = keyAction(current.phase, event.key);
      if (action === null) return;

      event.preventDefault();
      if (action.kind === "reveal") controller.reveal();
      else if (action.kind === "next") controller.next();
      else void controller.grade(action.grade);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller]);

  if (state.phase === "finished" || state.phase === "empty") {
    return (
      <section className="screen screen--done">
        <MoodPlant mood="strong" />
        <h1 className="display">
          {state.phase === "empty" ? "На сегодня всё" : "Круг пройден"}
        </h1>
        {state.session.answered > 0 && (
          <p className="quiet">
            Карточек закрыто: {state.session.completed}
            {state.session.repeats > 0 && `, возвратов: ${state.session.repeats}`}
          </p>
        )}
        <button type="button" className="pill" onClick={onFinish}>
          К началу
        </button>
      </section>
    );
  }

  const card = state.card;
  if (card === null) return <section className="screen">Загрузка…</section>;

  if (state.phase === "feedback") {
    const grade = state.lastGrade ?? "good";
    const mood = GRADE_MOOD[grade];
    return (
      <section className="screen screen--review">
        <ProgressHeader state={state} />
        <div className="feedback">
          {mood === "strong" && <div className="feedback-glow" />}
          <MoodPlant mood={mood} />
          <h2 className={`display feedback-title feedback-title--${mood}`}>
            {mood === "weak" ? "Ничего страшного" : "Отлично!"}
          </h2>
          <p className={`feedback-sub feedback-sub--${mood}`}>
            {mood === "weak" ? "Повторим карточку через " : "Следующий показ — через "}
            {formatInterval(state.lastInterval ?? 0)}
          </p>
          <p className="feedback-grade">Вы выбрали: {GRADE_LABELS[grade]}</p>
          <button type="button" className="pill" onClick={() => controller.next()}>
            Далее
          </button>
        </div>
      </section>
    );
  }

  const answered = state.phase === "answered";
  const [before, after] = card.text.split("___");

  return (
    <section className="screen screen--review">
      <ProgressHeader state={state} />

      <div className="panel">
        <PanelFlourish position="start" />
        <PanelFlourish position="end" />

        <div className="label">{answered ? "Ответ" : "Заполните пропуск"}</div>

        <p className="sentence">
          {before}
          {answered ? <strong className="answer">{card.answer}</strong> : <span className="gap">_____</span>}
          {after}
        </p>

        {card.translation !== null && <p className="translation">{card.translation}</p>}

        {!answered && <p className="hint">{card.hint}</p>}

        {answered && card.note !== null && <p className="note">{card.note}</p>}

        {answered && card.also.length > 0 && (
          // В макете этой строки нет, но без неё самопроверка врёт: партнёры
          // кластера взаимозаменяемы, и вспомнивший `take` вместо `make`
          // ответил верно.
          <p className="also">так же подошло бы: {card.also.join(", ")}</p>
        )}

        {answered && (
          <div className="tailpiece">
            <span className="tailpiece-line" />
            <svg className="tailpiece-leaf" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 9 C1 7 1 3 5 1 C9 3 9 7 5 9 Z" fill="#B8892B" />
            </svg>
            <span className="tailpiece-line" />
          </div>
        )}
      </div>

      {!answered && (
        <button type="button" className="pill pill--wide" onClick={() => controller.reveal()}>
          Показать ответ
        </button>
      )}

      {answered && (
        <div className="grades">
          {GRADES.map((grade, index) => (
            <button
              key={grade}
              type="button"
              className={`grade grade--${grade}`}
              disabled={state.saving}
              onClick={() => void controller.grade(grade)}
            >
              <GradeIcon grade={grade} />
              <span className="grade-label">{GRADE_LABELS[grade]}</span>
              <span className="grade-interval">
                {state.intervals ? formatInterval(state.intervals[grade]) : ""}
              </span>
              <span className="grade-key">{index + 1}</span>
            </button>
          ))}
        </div>
      )}

      {state.error !== null && <p className="error">{state.error}</p>}
    </section>
  );
}
