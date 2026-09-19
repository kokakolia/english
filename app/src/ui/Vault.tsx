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
 */

import { useRef, useState } from "react";

import { formatBytes, type StorageStatus } from "../app/persistence";
import {
  backupFileName,
  exportBackupJson,
  restoreBackup,
  type AppDatabase,
  type RestoreResult,
} from "../storage";

interface Props {
  db: AppDatabase;
  storage: StorageStatus | null;
  /** Перечитать экран дня: после восстановления счётчики другие. */
  onRestored: () => void;
}

type Note =
  | { kind: "none" }
  | { kind: "saved"; name: string }
  | { kind: "restored"; result: RestoreResult }
  | { kind: "error"; message: string };

export function Vault({ db, storage, onRestored }: Props) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>({ kind: "none" });
  const fileInput = useRef<HTMLInputElement>(null);

  async function save() {
    setBusy(true);
    setNote({ kind: "none" });
    try {
      const json = await exportBackupJson(db);
      const name = backupFileName();
      // Ссылка с `download` — единственный способ отдать файл из браузера,
      // не спрашивая разрешений и не завися от File System Access API,
      // которого нет в Firefox и Safari.
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setNote({ kind: "saved", name });
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
      const data: unknown = JSON.parse(await file.text());
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
    <div className="vault">
      <div className="vault-row">
        <button type="button" className="pill pill--small" onClick={() => void save()} disabled={busy}>
          Сохранить копию
        </button>
        <button
          type="button"
          className="pill pill--small pill--quiet"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          Восстановить
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="vault-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void restore(file);
          }}
        />
      </div>

      <StorageLine storage={storage} />
      <NoteLine note={note} />
    </div>
  );
}

function StorageLine({ storage }: { storage: StorageStatus | null }) {
  if (storage === null) return null;

  if (!storage.supported) {
    return (
      <p className="quiet">
        Браузер не умеет постоянное хранилище — держите копию в файле.
      </p>
    );
  }

  const size = storage.usage === null ? null : formatBytes(storage.usage);

  if (!storage.persisted) {
    return (
      <p className="warn">
        Браузер не дал разрешения хранить данные постоянно: при нехватке места
        он вправе их стереть. Установите приложение как программу — тогда
        разрешение обычно выдаётся, — и держите копию в файле.
      </p>
    );
  }

  return (
    <p className="quiet">
      Прогресс хранится постоянно{size === null ? "" : `, занято ${size}`}. Браузер
      не сотрёт его сам.
    </p>
  );
}

function NoteLine({ note }: { note: Note }) {
  if (note.kind === "none") return null;
  if (note.kind === "error") return <p className="error">{note.message}</p>;
  if (note.kind === "saved") return <p className="quiet">Копия сохранена: {note.name}</p>;

  const { result } = note;
  return (
    <p className="quiet">
      Восстановлено: карточек {result.cards}, прогресса {result.progress}, записей
      журнала {result.reviews}
      {result.duplicateReviews > 0 && ` (${result.duplicateReviews} уже были)`}.
    </p>
  );
}
