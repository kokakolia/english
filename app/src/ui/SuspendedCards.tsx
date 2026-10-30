import { useEffect, useState } from "react";
import {
  loadSuspendedCards,
  unsuspendCard,
  type AppDatabase,
  type StoredCard,
} from "../storage";
import type { BeginStorageOperation } from "./BackupRestore";

interface Props {
  db: AppDatabase;
  deckId: string;
  beginOperation: BeginStorageOperation;
  onClose: () => void;
}

export function SuspendedCards({ db, deckId, beginOperation, onClose }: Props) {
  const [cards, setCards] = useState<StoredCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void loadSuspendedCards(db, deckId).then(
      (rows) => {
        if (current) {
          setCards(rows);
          setLoading(false);
        }
      },
      (cause) => {
        if (current) {
          setError(String(cause));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [db, deckId, attempt]);

  async function restore(cardId: string) {
    const release = beginOperation();
    if (release === null) return;
    setBusy(true);
    setError(null);
    try {
      await unsuspendCard(db, { deckId, cardId });
      setCards(await loadSuspendedCards(db, deckId));
    } catch (cause) {
      setError(`Не удалось вернуть карточку: ${String(cause)}`);
    } finally {
      setBusy(false);
      release();
    }
  }

  const search = query.trim().toLowerCase();
  const visible = cards.filter((card) =>
    `${card.phrase} ${card.text} ${card.answer}`.toLowerCase().includes(search),
  );
  return (
    <section className="screen screen--suspended">
      <h1 className="display">Убранные карточки</h1>
      <p className="quiet">
        Верните карточку в обучение — её расписание и история сохранятся.
      </p>
      {loading ? (
        <p role="status">Загрузка…</p>
      ) : (
        <>
          {cards.length > 0 && (
            <input
              className="suspended-search"
              type="search"
              aria-label="Поиск по карточкам"
              placeholder="Найти карточку"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {cards.length === 0 && error === null && (
            <p role="status">Убранных карточек нет.</p>
          )}
          {cards.length > 0 && visible.length === 0 && (
            <p role="status">Ничего не найдено.</p>
          )}
          <ul className="suspended-list" aria-label="Убранные карточки">
            {visible.map((card) => (
              <li key={card.id}>
                <div>
                  <strong>{card.phrase}</strong>
                  <p>{card.text.replace("___", card.answer)}</p>
                </div>
                <button
                  type="button"
                  className="pill pill--quiet"
                  disabled={busy}
                  onClick={() => void restore(card.id)}
                >
                  Вернуть в обучение
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error !== null && (
        <div role="alert">
          <p className="error">{error}</p>
          <button
            type="button"
            className="pill pill--quiet"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Обновить список
          </button>
        </div>
      )}
      <button type="button" className="pill" disabled={busy} onClick={onClose}>
        К занятию
      </button>
    </section>
  );
}
