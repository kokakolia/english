/**
 * Сохранность прогресса: состояние хранилища и копия в файл.
 *
 * Бэкенда нет, значит единственный экземпляр выученного лежит в браузере на
 * этом устройстве. Отсюда два обязательства перед человеком, и оба выполняются
 * здесь.
 *
 * Первое — **сказать правду о хранилище**. Если браузер не дал разрешения на
 * постоянное хранение, прогресс может быть вытеснен, и знать об этом должен
 * владелец прогресса, а не только код.
 *
 * Второе — **дать унести копию**. Файл, лежащий вне браузера, — единственное,
 * что переживёт очистку данных сайта, переустановку системы и смену машины.
 *
 * Всё это спрятано за тремя точками, а не разложено на экране дня. Первая
 * версия показывала предупреждение красным блоком под кнопкой «Учить», и это
 * было неправильно: условие не меняется день ото дня, а экран дня человек
 * видит каждый раз перед занятием. Предупреждение, которое нельзя убрать,
 * через неделю перестаёт читаться — остаётся только раздражение. Поэтому
 * теперь о нём говорит тихая метка на кнопке меню, а подробности внутри.
 */

import { useEffect, useState } from "react";

import {
  canSaveSilently,
  forgetFolder,
  gzip,
  savedFolderName,
  saveBackupFile,
} from "../app/backup-file";

import {
  formatBytes,
  isInstalled,
  storageAdvice,
  storageAtRisk,
  type StorageStatus,
} from "../app/persistence";
import { backupFileName, exportBackupJson, type AppDatabase } from "../storage";
import type { ThemeChoice } from "../app/theme";
import { Dropdown } from "./Dropdown";
import { BackupRestore, type BeginStorageOperation } from "./BackupRestore";

interface Props {
  db: AppDatabase;
  storage: StorageStatus | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  /** Перечитать экран дня: после восстановления счётчики другие. */
  onRestored: () => Promise<void>;
  beginOperation: BeginStorageOperation;
  storageBusy: boolean;
  onSuspended: () => void;
}

const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "как в системе",
  light: "светлая",
  dark: "тёмная",
};

/** Следующий выбор по кругу. Три состояния не влезают в переключатель. */
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

type Note =
  | { kind: "none" }
  | { kind: "saved"; where: string; size: string }
  | { kind: "error"; message: string };

export function Vault({
  db,
  storage,
  theme,
  onTheme,
  onRestored,
  beginOperation,
  storageBusy,
  onSuspended,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>({ kind: "none" });
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    void savedFolderName(db).then(setFolder);
  }, [db]);

  async function save() {
    const release = beginOperation();
    if (release === null) return;
    setBusy(true);
    setNote({ kind: "none" });
    try {
      // Самодостаточная копия переживает смену версии и исчезновение колоды.
      const json = await exportBackupJson(db);
      const data = await gzip(json);
      const name = backupFileName(new Date(), "json.gz");

      const outcome = await saveBackupFile(db, name, data);
      if (outcome.kind === "cancelled") {
        setNote({ kind: "none" });
        return;
      }
      setNote({
        kind: "saved",
        where: outcome.kind === "saved" ? outcome.folder : "Загрузки",
        size: formatBytes(outcome.bytes),
      });
      setFolder(await savedFolderName(db));
    } catch (cause) {
      setNote({
        kind: "error",
        message: `не удалось сохранить копию: ${String(cause)}`,
      });
    } finally {
      setBusy(false);
      release();
    }
  }

  return (
    <Dropdown
      title="Копия и хранилище"
      marked={storageAtRisk(storage)}
      keepMounted
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => void save()}
            disabled={busy || storageBusy}
          >
            <span className="menu-item-label">Сохранить копию</span>
            <span className="menu-item-hint">
              {folder !== null
                ? `молча в папку «${folder}»`
                : canSaveSilently()
                  ? "первый раз спросит папку, дальше молча"
                  : "файл уйдёт в загрузки"}
            </span>
          </button>

          <BackupRestore
            db={db}
            beginOperation={beginOperation}
            onRestored={onRestored}
            disabled={busy || storageBusy}
            menuItem
          />

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={busy || storageBusy}
            onClick={() => {
              close();
              onSuspended();
            }}
          >
            <span className="menu-item-label">Убранные карточки</span>
            <span className="menu-item-hint">
              посмотреть и вернуть в обучение
            </span>
          </button>

          {folder !== null && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={busy || storageBusy}
              onClick={() => {
                void forgetFolder(db).then(() => setFolder(null));
                setNote({ kind: "none" });
              }}
            >
              <span className="menu-item-label">Выбрать другую папку</span>
              <span className="menu-item-hint">
                сейчас копии идут в «{folder}»
              </span>
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => onTheme(NEXT_THEME[theme])}
          >
            <span className="menu-item-label">Тема: {THEME_LABELS[theme]}</span>
            <span className="menu-item-hint">
              нажмите, чтобы выбрать {THEME_LABELS[NEXT_THEME[theme]]}
            </span>
          </button>

          <StorageNote storage={storage} />
          <NoteLine note={note} />
          <BuildStamp />
        </>
      )}
    </Dropdown>
  );
}

function StorageNote({ storage }: { storage: StorageStatus | null }) {
  const advice = storageAdvice(storage, isInstalled());
  if (advice === null) return null;

  if (advice === "unsupported") {
    return (
      <p className="menu-foot menu-foot--warn">
        Браузер не умеет постоянное хранилище — держите копию в файле.
      </p>
    );
  }

  if (advice === "install" || advice === "stuck") {
    return (
      <p className="menu-foot menu-foot--warn">
        Браузер не дал разрешения хранить данные постоянно: при нехватке места
        он вправе их стереть.{" "}
        {advice === "stuck"
          ? "Приложение уже установлено, но разрешения это не добавило — остаётся копия в файле."
          : "Установите приложение как программу — тогда разрешение обычно выдаётся."}
      </p>
    );
  }

  const size = storage?.usage == null ? null : formatBytes(storage.usage);
  return (
    <p className="menu-foot">
      Прогресс хранится постоянно{size === null ? "" : `, занято ${size}`}.
      Браузер не сотрёт его сам.
    </p>
  );
}

/** Когда собрана открытая версия. Ответ на вопрос «обновилось ли». */
function BuildStamp() {
  // В тестах и вне сборки vite подстановки нет — молчим, а не падаем.
  if (typeof __BUILD_STAMP__ === "undefined") return null;
  return <p className="menu-foot">Сборка от {__BUILD_STAMP__}</p>;
}

function NoteLine({ note }: { note: Note }) {
  if (note.kind === "none") return null;
  if (note.kind === "error")
    return <p className="menu-foot menu-foot--warn">{note.message}</p>;
  if (note.kind === "saved") {
    return (
      <p className="menu-foot">
        Копия сохранена в «{note.where}», {note.size}.
      </p>
    );
  }

  return null;
}
