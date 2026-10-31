/**
 * Экран начала дня.
 *
 * В макете его нет — он собран в том же визуальном языке: та же панель, те же
 * разделители, та же типографика. Когда дойдут руки нарисовать и его, менять
 * придётся только вёрстку.
 */

import type { ReactNode } from "react";

import type { DeckCounts, StoredDeck } from "../storage";
import { plural } from "./format";
import { Leaf, PanelFlourish } from "./Ornaments";

interface Props {
  deckName: string;
  counts: DeckCounts;
  backlog: number;
  offline: boolean;
  onStart: () => void;
  storageBusy?: boolean;
  /** Меню сохранности прогресса. Живёт отдельным компонентом. */
  vault?: ReactNode;
  decks?: readonly StoredDeck[];
  deckId?: string;
  onDeckChange?: (id: string) => void;
}

export function DayScreen({
  deckName,
  counts,
  backlog,
  offline,
  onStart,
  vault,
  storageBusy = false,
  decks = [],
  deckId,
  onDeckChange,
}: Props) {
  const ready = counts.fresh > 0 || counts.due > 0;

  return (
    <section className="screen screen--day">
      {/* Меню прижато к правому верхнему углу — там же, где меню карточки
          на экране повторения, чтобы не искать его в двух местах. */}
      <div className="day-top">{vault}</div>

      {decks.length > 1 && (
        <label className="deck-picker">
          <span>Колода</span>
          <select
            aria-label="Выбрать колоду"
            value={deckId}
            disabled={storageBusy}
            onChange={(event) => onDeckChange?.(event.target.value)}
          >
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="day-head">
        <Leaf className="counter-leaf" />
        <h1 className="display">{deckName}</h1>
        <Leaf className="counter-leaf counter-leaf--flip" />
      </div>

      <div className="rule">
        <span className="rule-line" />
        <span className="rule-dot" />
        <span className="rule-line rule-line--rev" />
      </div>

      <div className="panel">
        <PanelFlourish position="start" />
        <PanelFlourish position="end" />

        <dl className="counts">
          <div>
            <dt>Новые</dt>
            <dd>{counts.fresh}</dd>
          </div>
          <div>
            <dt>К повторению</dt>
            <dd>{counts.due}</dd>
          </div>
          <div>
            <dt>Всего</dt>
            <dd>{counts.total}</dd>
          </div>
        </dl>

        {backlog > 0 && (
          <p className="note">
            Просрочено сверх дневного лимита: {backlog}{" "}
            {plural(backlog, "карточка")}. Они не потеряются, но разбирать их
            придётся несколько дней. Новые карточки пока отложены, чтобы не
            увеличивать нагрузку.
          </p>
        )}
      </div>

      <button
        type="button"
        className="pill pill--wide"
        onClick={onStart}
        disabled={!ready || storageBusy}
      >
        {ready
          ? "Учить"
          : counts.nextReviewAt
            ? "Сейчас карточек нет"
            : "На сегодня всё"}
      </button>

      {!ready && counts.nextReviewAt && (
        <p className="quiet">
          Следующие карточки доступны:{" "}
          {new Date(counts.nextReviewAt).toLocaleString("ru-RU", {
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          })}
          . Можно закрыть приложение и вернуться позже.
        </p>
      )}
      {!ready && (counts.reviewLimitReached || counts.newLimitReached) && (
        <p className="quiet">
          Дневной лимит новых карточек или обычных повторений достигнут. Лимиты
          обновляются в полночь; короткие учебные повторы остаются доступны по
          расписанию.
        </p>
      )}
      {!ready && (counts.newCardsDisabled || counts.reviewsDisabled) && (
        <p className="quiet">
          Дневными лимитами отключены:{" "}
          {[
            counts.newCardsDisabled ? "новые карточки" : "",
            counts.reviewsDisabled ? "обычные повторения" : "",
          ]
            .filter(Boolean)
            .join(" и ")}
          . Короткие учебные повторы остаются доступны по расписанию.
        </p>
      )}

      {offline && (
        <p className="quiet">
          Часть обновлений недоступна — можно заниматься загруженными колодами.
        </p>
      )}
    </section>
  );
}
