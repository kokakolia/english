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

import { useEffect, useRef, useState } from "react";

import {
  canSaveSilently,
  forgetFolder,
  gunzipIfNeeded,
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
import {
  backupFileName,
  exportBackupJson,
  restoreBackup,
  type AppDatabase,
  type RestoreResult,
} from "../storage";
import { Dropdown } from "./Dropdown";

interface Props {
  db: AppDatabase;
  storage: StorageStatus | null;
  /** Перечитать экран дня: после восстановления счётчики другие. */
  onRestored: () => void;
}

type Note =
  | { kind: "none" }
  | { kind: "saved"; where: string; size: string }
  | { kind: "restored"; result: RestoreResult }
  | { kind: "error"; message: string };

export function Vault({ db, storage, onRestored }: Props) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>({ kind: "none" });
  const [folder, setFolder] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void savedFolderName(db).then(setFolder);
  }, [db]);

  async function save() {
    setBusy(true);
    setNote({ kind: "none" });
    try {
      // Без карточек: они лежат в самом приложении и подтягиваются заново при
      // запуске. В копии они занимали шесть седьмых объёма, ничего при этом
      // не сохраняя, — потерять можно только прогресс и журнал.
      const json = await exportBackupJson(db, { includeCards: false });
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
      setNote({ kind: "error", message: `не удалось сохранить копию: ${String(cause)}` });
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: File) {
    setBusy(true);
    setNote({ kind: "none" });
    try {
      // Копия может быть и сжатой, и обычной: старые файлы должны читаться.
      const data: unknown = JSON.parse(await gunzipIfNeeded(file));
      // `merge`, а не `replace`: по каждой карточке берётся более свежий
      // прогресс. Восстановление из старой копии не должно стирать то, что
      // выучено после неё, — а именно так поступил бы `replace`.
      const result = await restoreBackup(db, data, { mode: "merge" });
      setNote({ kind: "restored", result });
      onRestored();
    } catch (cause) {
      setNote({ kind: "error", message: `не удалось прочитать копию: ${String(cause)}` });
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = "";
    }
  }

  return (
    <Dropdown title="Копия и хранилище" marked={storageAtRisk(storage)}>
      {() => (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => void save()}
            disabled={busy}
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

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <span className="menu-item-label">Восстановить из копии</span>
            <span className="menu-item-hint">берётся более свежее, выученное не пропадёт</span>
          </button>

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,.gz"
            className="vault-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void restore(file);
            }}
          />

          {folder !== null && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                void forgetFolder(db).then(() => setFolder(null));
                setNote({ kind: "none" });
              }}
            >
              <span className="menu-item-label">Выбрать другую папку</span>
              <span className="menu-item-hint">сейчас копии идут в «{folder}»</span>
            </button>
          )}

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
      Прогресс хранится постоянно{size === null ? "" : `, занято ${size}`}. Браузер
      не сотрёт его сам.
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
  if (note.kind === "error") return <p className="menu-foot menu-foot--warn">{note.message}</p>;
  if (note.kind === "saved") {
    return (
      <p className="menu-foot">
        Копия сохранена в «{note.where}», {note.size}.
      </p>
    );
  }

  const { result } = note;
  return (
    <p className="menu-foot">
      Восстановлено: карточек {result.cards}, прогресса {result.progress}, записей
      журнала {result.reviews}
      {result.duplicateReviews > 0 && ` (${result.duplicateReviews} уже были)`}.
    </p>
  );
}
