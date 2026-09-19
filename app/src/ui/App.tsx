/**
 * Сборка приложения из экранов.
 *
 * Здесь только переключение между двумя экранами и подписка на контроллер.
 * Никакой логики занятия: она в `study/controller`, и это намеренно — вёрстку
 * мы будем менять, а логику нет.
 */

import { useCallback, useEffect, useState } from "react";

import { bootstrap } from "../app/bootstrap";
import { ensurePersistentStorage, type StorageStatus } from "../app/persistence";
import {
  deckCounts,
  getStudySettings,
  type AppDatabase,
  type DeckCounts,
  type StoredDeck,
} from "../storage";
import { createStudyController, type StudyController, type StudyState } from "../study/controller";
import { DayScreen } from "./DayScreen";
import { Background, CornerFern, OrnamentDefs, SideVine } from "./Ornaments";
import { ReviewScreen } from "./ReviewScreen";
import { Vault } from "./Vault";

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
  const [storage, setStorage] = useState<StorageStatus | null>(null);

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
      // Разрешение спрашивается до открытия колоды: если браузер откажет,
      // человек увидит это на первом же экране, а не после месяца занятий.
      const status = await ensurePersistentStorage();
      const result = await bootstrap();
      if (cancelled) return;
      setStorage(status);

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

  return (
    <main className="app">
      <OrnamentDefs />
      <Background />
      <CornerFern corner="tl" />
      <CornerFern corner="tr" />
      <CornerFern corner="bl" />
      <CornerFern corner="br" />
      <SideVine />
      {renderStage()}
    </main>
  );

  function renderStage() {
    if (stage.kind === "loading") {
      return <section className="screen">Загрузка…</section>;
    }

    if (stage.kind === "error") {
      return (
        <section className="screen">
          <h1 className="display">Не удалось начать</h1>
          <p className="error">{stage.message}</p>
        </section>
      );
    }

    if (stage.kind === "day") {
      return (
        <DayScreen
          deckName={deck?.name ?? "Колода"}
          counts={stage.counts}
          backlog={stage.counts.backlog}
          offline={offline}
          onStart={() => void startStudy()}
          vault={
            db === null ? null : (
              <Vault
                db={db}
                storage={storage}
                onRestored={() => {
                  if (db !== null && deck !== null) void showDay(db, deck.id);
                }}
              />
            )
          }
        />
      );
    }

    if (controller !== null && state !== null) {
      return (
        <ReviewScreen
          controller={controller}
          state={state}
          onFinish={() => void finishStudy()}
        />
      );
    }
    return <section className="screen">Готовим очередь…</section>;
  }
}
