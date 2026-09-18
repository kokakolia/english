/**
 * Экран повторения по макету из `design/`.
 *
 * Два состояния карточки — пропуск скрыт и ответ раскрыт — плюс итоги в конце
 * занятия. Логика здесь не живёт: компонент показывает состояние контроллера и
 * пересылает нажатия.
 *
 * Разметка разделена на три слоя: шапка, растягивающаяся середина и кнопки
 * внизу. Прокручивается при нужде только середина — так кнопки оценки всегда
 * на виду, сколько бы ни было текста, и страница не уезжает целиком.
 */

import { useEffect } from "react";

import { GRADES, type Grade } from "../srs";
import { keyAction, type StudyController, type StudyState } from "../study/controller";
import { formatInterval, plural } from "./format";
import { GradeIcon, Leaf, MoodPlant, PanelFlourish, UndoArrow } from "./Ornaments";

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

/** Сколько точек в полосе прогресса. Больше не помещается на телефоне. */
const DOT_COUNT = 8;

interface Props {
  controller: StudyController;
  state: StudyState;
  onFinish: () => void;
}

/**
 * Кнопка отмены.
 *
 * Держится скромно и не исчезает, когда отменять нечего, а гаснет: кнопка,
 * появляющаяся и пропадающая, дёргает соседей и сама сдвигается под курсором.
 */
function UndoButton({ controller, state }: { controller: StudyController; state: StudyState }) {
  return (
    <button
      type="button"
      className="undo"
      onClick={() => void controller.undo()}
      disabled={!state.canUndo || state.saving}
      title="Вернуться к предыдущей карточке (Backspace)"
    >
      <UndoArrow />
      <span className="undo-label">Назад</span>
    </button>
  );
}

function ProgressHeader({
  controller,
  state,
}: {
  controller: StudyController;
  state: StudyState;
}) {
  const total = Math.max(1, state.session.remaining + state.session.answered);
  const done = state.session.answered;
  // Точки — грубая полоса прогресса: карточек за день бывает и полторы сотни,
  // и рисовать их поштучно бессмысленно. Точные числа рядом, в счётчике.
  const filled = Math.min(DOT_COUNT, Math.round((done / total) * DOT_COUNT));

  return (
    <header className="topbar">
      <div className="head">
        <UndoButton controller={controller} state={state} />
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
    </header>
  );
}

/** Итоги занятия. Показываются один раз в конце, а не после каждой карточки. */
function Summary({
  controller,
  state,
  onFinish,
}: {
  controller: StudyController;
  state: StudyState;
  onFinish: () => void;
}) {
  const { tally, session } = state;
  const strong = tally.good + tally.easy;
  const answers = session.answered;
  const share = answers > 0 ? Math.round((strong / answers) * 100) : 0;
  const nothingDone = answers === 0;

  return (
    <section className="screen screen--done">
      <div className="middle middle--center">
        <div className="summary">
          {!nothingDone && <div className="feedback-glow" />}
          <MoodPlant mood={nothingDone ? "weak" : "strong"} />
          <h1 className="display summary-title">
            {nothingDone ? "На сегодня всё" : "Круг пройден"}
          </h1>

          {!nothingDone && (
            <>
              <p className="summary-sub">
                {session.completed} {plural(session.completed, "карточка")}, вспомнили{" "}
                {share}%
              </p>

              <dl className="tally">
                {GRADES.map((grade) => (
                  <div key={grade} className={`tally-row tally-row--${grade}`}>
                    <dt>
                      <GradeIcon grade={grade} />
                      {GRADE_LABELS[grade]}
                    </dt>
                    <dd>{tally[grade]}</dd>
                  </div>
                ))}
              </dl>

              {session.repeats > 0 && (
                <p className="quiet">
                  Возвратов внутри занятия: {session.repeats}. Это карточки, которые
                  показались снова после «не знал».
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="bottombar bottombar--done">
        {state.canUndo && (
          // На итогах отмена нужна не меньше: промахнуться по кнопке легче
          // всего на последней карточке, когда занятие уже позади.
          <button
            type="button"
            className="pill pill--quiet"
            onClick={() => void controller.undo()}
            disabled={state.saving}
          >
            Вернуть карточку
          </button>
        )}
        <button type="button" className="pill" onClick={onFinish}>
          К началу
        </button>
      </footer>
    </section>
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
      else if (action.kind === "undo") void controller.undo();
      else void controller.grade(action.grade);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller]);

  if (state.phase === "finished" || state.phase === "empty") {
    return <Summary controller={controller} state={state} onFinish={onFinish} />;
  }

  const card = state.card;
  if (card === null) return <section className="screen">Загрузка…</section>;

  const answered = state.phase === "answered";
  const [before, after] = card.text.split("___");

  return (
    <section className="screen screen--review">
      <ProgressHeader controller={controller} state={state} />

      <div className="middle">
        <div className="panel">
          <PanelFlourish position="start" />
          <PanelFlourish position="end" />

          <div className="label">{answered ? "Ответ" : "Заполните пропуск"}</div>

          <p className="sentence">
            {before}
            {answered ? (
              <strong className="answer">{card.answer}</strong>
            ) : (
              <span className="gap">_____</span>
            )}
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
      </div>

      <footer className="bottombar">
        {!answered ? (
          <button type="button" className="pill pill--wide" onClick={() => controller.reveal()}>
            Показать ответ
          </button>
        ) : (
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
      </footer>
    </section>
  );
}
