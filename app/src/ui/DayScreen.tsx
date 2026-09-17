/**
 * Экран начала дня.
 *
 * Три числа и кнопка. Завал показывается отдельной строкой и только когда он
 * есть: это единственный способ узнать, что долг накопился, и прятать его
 * нельзя — но и пугать им каждый день, когда его нет, незачем.
 */

import type { DeckCounts } from "../storage";
import { plural } from "./format";

interface Props {
  deckName: string;
  counts: DeckCounts;
  backlog: number;
  offline: boolean;
  onStart: () => void;
}

export function DayScreen({ deckName, counts, backlog, offline, onStart }: Props) {
  const ready = counts.fresh > 0 || counts.due > 0;

  return (
    <section className="screen screen--day">
      <h1>{deckName}</h1>

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
          <dt>Всего в колоде</dt>
          <dd>{counts.total}</dd>
        </div>
      </dl>

      {backlog > 0 && (
        <p className="backlog">
          Просрочено сверх дневного лимита: {backlog}{" "}
          {plural(backlog, "карточка")}. Они не потеряются, но разбирать их
          придётся несколько дней.
        </p>
      )}

      <button type="button" onClick={onStart} disabled={!ready}>
        {ready ? "Учить" : "На сегодня всё"}
      </button>

      {offline && (
        <p className="muted">
          Свежую колоду достать не удалось — занимаемся тем, что уже загружено.
        </p>
      )}
    </section>
  );
}
