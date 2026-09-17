/**
 * Сборка приложения из экранов.
 *
 * Здесь только переключение между двумя экранами и подписка на контроллер.
 * Никакой логики занятия: она в `study/controller`, и это намеренно — вёрстку
 * мы будем менять, а логику нет.
 */

import { useCallback, useEffect, useState } from "react";

import { bootstrap } from "../app/bootstrap";
import {
  deckCounts,
  getStudySettings,
  type AppDatabase,
  type DeckCounts,
  type StoredDeck,
} from "../storage";
import { createStudyController, type StudyController, type StudyState } from "../study/controller";
import { DayScreen } from "./DayScreen";
import { ReviewScreen } from "./ReviewScreen";

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "day"; counts: DeckCounts }
  | { kind: "study" };

export function App() {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [db, setDb] = useState<AppDatabase | null>(null);
  const [deck, setDeck] = useState<StoredDeck | null>(null);
  const [offline, setOffline] = useState(false);
  const [controller, setController] = useState<StudyController | null>(null);
  const [state, setState] = useState<StudyState | null>(null);

  const showDay = useCallback(
    async (database: AppDatabase, deckId: string) => {
      const settings = await getStudySettings(database);
      const counts = await deckCounts(
        database,
        deckId,
        new Date(),
        settings.reviewsPerDay,
      );
      setStage({ kind: "day", counts });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await bootstrap();
      if (cancelled) return;

      const first = result.decks[0];
      if (first === undefined) {
        setStage({ kind: "error", message: result.error ?? "колода не найдена" });
        return;
      }
      setDb(result.db);
      setDeck(first);
      setOffline(result.offline);
      await showDay(result.db, first.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [showDay]);

  // Подписка на контроллер: он сам сообщает, когда состояние изменилось.
  useEffect(() => {
    if (controller === null) return;
    setState(controller.state());
    return controller.subscribe(setState);
  }, [controller]);

  async function startStudy() {
    if (db === null || deck === null) return;
    setStage({ kind: "study" });
    setController(await createStudyController({ db, deckId: deck.id }));
  }

  async function finishStudy() {
    setController(null);
    setState(null);
    if (db !== null && deck !== null) await showDay(db, deck.id);
  }

  if (stage.kind === "loading") {
    return <main className="app">Загрузка…</main>;
  }

  if (stage.kind === "error") {
    return (
      <main className="app">
        <section className="screen">
          <h1>Не удалось начать</h1>
          <p className="error">{stage.message}</p>
        </section>
      </main>
    );
  }

  if (stage.kind === "day") {
    return (
      <main className="app">
        <DayScreen
          deckName={deck?.name ?? "Колода"}
          counts={stage.counts}
          backlog={stage.counts.backlog}
          offline={offline}
          onStart={() => void startStudy()}
        />
      </main>
    );
  }

  return (
    <main className="app">
      {controller !== null && state !== null ? (
        <ReviewScreen
          controller={controller}
          state={state}
          onFinish={() => void finishStudy()}
        />
      ) : (
        <section className="screen">Готовим очередь…</section>
      )}
    </main>
  );
}
