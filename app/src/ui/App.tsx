/**
 * Сборка приложения из экранов.
 *
 * Здесь только переключение между двумя экранами и подписка на контроллер.
 * Никакой логики занятия: она в `study/controller`, и это намеренно — вёрстку
 * мы будем менять, а логику нет.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { bootstrap } from "../app/bootstrap";
import { watchDay } from "../app/day-refresh";
import { updateSafety } from "../app/update-safety";
import {
  applyTheme,
  isDarkNow,
  readTheme,
  saveTheme,
  type ThemeChoice,
} from "../app/theme";
import {
  ensurePersistentStorage,
  type StorageStatus,
} from "../app/persistence";
import {
  deckCounts,
  getStudySettings,
  getDatabase,
  listUsableDecks,
  type AppDatabase,
  type DeckCounts,
  type StoredDeck,
} from "../storage";
import {
  createStudyController,
  type StudyController,
  type StudyState,
} from "../study/controller";
import { DayScreen } from "./DayScreen";
import {
  DeepBackground,
  DeepDefs,
  GlowTendrils,
  KelpCorner,
  Plankton,
} from "./DeepOrnaments";
import {
  Background,
  CornerFern,
  OrnamentDefs,
  SideFern,
  SideVine,
} from "./Ornaments";
import { ReviewScreen } from "./ReviewScreen";
import { DarkProvider } from "./ThemeContext";
import { Vault } from "./Vault";
import { SuspendedCards } from "./SuspendedCards";
import { BackupRestore, type BeginStorageOperation } from "./BackupRestore";

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "day"; counts: DeckCounts }
  | { kind: "suspended" }
  | { kind: "study" };

export function App() {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [db, setDb] = useState<AppDatabase | null>(null);
  const [deck, setDeck] = useState<StoredDeck | null>(null);
  const [offline, setOffline] = useState(false);
  const [controller, setController] = useState<StudyController | null>(null);
  const [state, setState] = useState<StudyState | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [theme, setThemeState] = useState<ThemeChoice>(() => readTheme());
  const [dark, setDark] = useState(() => isDarkNow(readTheme()));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [storageBusy, setStorageBusy] = useState(false);
  const operationBusy = useRef(false);
  const currentStage = useRef(stage.kind);
  currentStage.current = stage.kind;

  useEffect(() => {
    updateSafety.setSafe(
      stage.kind === "day" && controller === null && !storageBusy,
    );
    return () => updateSafety.setSafe(false);
  }, [stage.kind, controller, storageBusy]);

  const beginStorageOperation: BeginStorageOperation = useCallback(() => {
    if (
      operationBusy.current ||
      !["day", "error", "suspended"].includes(currentStage.current)
    )
      return null;
    operationBusy.current = true;
    updateSafety.setSafe(false);
    const releaseUpdate = updateSafety.begin();
    setStorageBusy(true);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      operationBusy.current = false;
      setStorageBusy(false);
      updateSafety.setSafe(currentStage.current === "day");
      releaseUpdate();
    };
  }, []);

  // Слежение за системной настройкой: пока выбрано «как в системе», вечернее
  // переключение должно доходить до открытого приложения, а не ждать перезапуска.
  useEffect(() => {
    applyTheme(theme);
    setDark(isDarkNow(theme));
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((choice: ThemeChoice) => {
    saveTheme(choice);
    setThemeState(choice);
  }, []);

  const showDay = useCallback(
    async (
      database: AppDatabase,
      deckId: string,
      isCurrent: () => boolean = () => true,
    ) => {
      const settings = await getStudySettings(database);
      const counts = await deckCounts(
        database,
        deckId,
        new Date(),
        settings.reviewsPerDay,
        settings.newPerDay,
      );
      if (isCurrent()) setStage({ kind: "day", counts });
    },
    [],
  );

  useEffect(() => {
    if (stage.kind !== "day" || db === null || deck === null || storageBusy)
      return;
    let current = true;
    const isCurrent = () =>
      current && currentStage.current === "day" && !operationBusy.current;
    const stop = watchDay(
      () => showDay(db, deck.id, isCurrent),
      (cause) => {
        if (isCurrent())
          setStage({
            kind: "error",
            message: `Не удалось обновить состояние колоды: ${String(cause)}`,
          });
      },
    );
    return () => {
      current = false;
      stop();
    };
  }, [stage.kind, db, deck, showDay, storageBusy]);

  useEffect(() => {
    let cancelled = false;
    setStage({ kind: "loading" });
    setController(null);
    setState(null);
    void (async () => {
      try {
        // Разрешение спрашивается до открытия колоды: если браузер откажет,
        // человек увидит это на первом же экране, а не после месяца занятий.
        const status = await ensurePersistentStorage();
        const result = await bootstrap();
        if (cancelled) return;
        setStorage(status);
        setDb(result.db);

        const first = result.decks[0];
        if (first === undefined) {
          setStage({
            kind: "error",
            message: result.error ?? "колода не найдена",
          });
          return;
        }
        setDeck(first);
        setOffline(result.offline);
        await showDay(result.db, first.id, () => !cancelled);
      } catch (cause) {
        if (!cancelled)
          setStage({
            kind: "error",
            message: `Не удалось загрузить приложение: ${String(cause)}`,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showDay, loadAttempt]);

  // Подписка на контроллер: он сам сообщает, когда состояние изменилось.
  useEffect(() => {
    if (controller === null) return;
    setState(controller.state());
    return controller.subscribe(setState);
  }, [controller]);

  async function startStudy() {
    if (
      db === null ||
      deck === null ||
      stage.kind !== "day" ||
      operationBusy.current ||
      currentStage.current !== "day"
    )
      return;
    updateSafety.setSafe(false);
    currentStage.current = "study";
    setStage({ kind: "study" });
    try {
      setController(await createStudyController({ db, deckId: deck.id }));
    } catch (cause) {
      setStage({
        kind: "error",
        message: `Не удалось начать занятие: ${String(cause)}`,
      });
    }
  }

  async function finishStudy() {
    setController(null);
    setState(null);
    try {
      if (db !== null && deck !== null) await showDay(db, deck.id);
    } catch (cause) {
      setStage({
        kind: "error",
        message: `Не удалось прочитать состояние колоды: ${String(cause)}`,
      });
    }
  }

  async function afterRestore() {
    const database = db ?? getDatabase();
    const available = await listUsableDecks(database);
    const selected =
      available.find((item) => item.id === deck?.id) ?? available[0];
    setController(null);
    setState(null);
    if (!selected) {
      setDeck(null);
      setStage({
        kind: "error",
        message:
          "В копии нет полного набора карточек. Выберите полную резервную копию или повторите загрузку колоды.",
      });
      return;
    }
    await showDay(database, selected.id);
    setDb(database);
    setDeck(selected);
    setOffline(false);
  }

  return (
    <DarkProvider dark={dark}>
      <main className="app">
        {dark ? (
          <>
            <DeepDefs />
            <DeepBackground />
            <KelpCorner side="left" />
            <KelpCorner side="right" />
            <GlowTendrils />
            <Plankton />
          </>
        ) : (
          <>
            <OrnamentDefs />
            <Background />
            {/* Слева — папоротник вдоль края: тот же куст, но формой
              повторяющий лозу. Папоротники в углах остались справа. */}
            <CornerFern corner="tr" />
            <CornerFern corner="br" />
            <SideFern side="left" />
            <SideVine side="right" />
          </>
        )}
        {renderStage()}
      </main>
    </DarkProvider>
  );

  function renderStage() {
    if (stage.kind === "loading") {
      return <section className="screen">Загрузка…</section>;
    }

    if (stage.kind === "error") {
      return (
        <section className="screen" role="alert">
          <h1 className="display">Не удалось начать</h1>
          <p className="error">{stage.message}</p>
          <button
            type="button"
            className="pill"
            disabled={storageBusy}
            onClick={() => {
              if (operationBusy.current) return;
              currentStage.current = "loading";
              setStage({ kind: "loading" });
              setLoadAttempt((value) => value + 1);
            }}
          >
            Повторить попытку
          </button>
          <BackupRestore
            db={db ?? getDatabase()}
            beginOperation={beginStorageOperation}
            onRestored={afterRestore}
            disabled={storageBusy}
          />
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
          storageBusy={storageBusy}
          vault={
            db === null ? null : (
              <Vault
                db={db}
                storage={storage}
                theme={theme}
                onTheme={setTheme}
                onRestored={afterRestore}
                beginOperation={beginStorageOperation}
                storageBusy={storageBusy}
                onSuspended={() => {
                  if (operationBusy.current) return;
                  currentStage.current = "suspended";
                  updateSafety.setSafe(false);
                  setStage({ kind: "suspended" });
                }}
              />
            )
          }
        />
      );
    }

    if (stage.kind === "suspended" && db !== null && deck !== null) {
      return (
        <SuspendedCards
          db={db}
          deckId={deck.id}
          beginOperation={beginStorageOperation}
          onClose={() => void finishStudy()}
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
