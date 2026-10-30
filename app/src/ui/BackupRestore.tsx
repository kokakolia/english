import { useRef, useState } from "react";
import { gunzipIfNeeded } from "../app/backup-file";
import {
  restoreBackup,
  type AppDatabase,
  type RestoreResult,
} from "../storage";

/** Общая блокировка хранилища и занятия. null означает, что другая операция уже начата. */
export type BeginStorageOperation = () => (() => void) | null;

interface Props {
  db: AppDatabase;
  beginOperation: BeginStorageOperation;
  onRestored: () => Promise<void>;
  disabled?: boolean;
  menuItem?: boolean;
}

/** Восстановление доступно и из меню, и при невозможности открыть колоду. */
export function BackupRestore({
  db,
  beginOperation,
  onRestored,
  disabled = false,
  menuItem = false,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);

  async function restore(file: File) {
    const release = beginOperation();
    if (release === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data: unknown = JSON.parse(await gunzipIfNeeded(file));
      const restored = await restoreBackup(db, data, { mode: "merge" });
      await onRestored();
      setResult(restored);
    } catch (cause) {
      setError(`Не удалось восстановить копию: ${String(cause)}`);
    } finally {
      if (input.current !== null) input.current.value = "";
      setBusy(false);
      release();
    }
  }

  return (
    <>
      <button
        type="button"
        role={menuItem ? "menuitem" : undefined}
        className={menuItem ? "menu-item" : "pill pill--quiet"}
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        {menuItem ? (
          <>
            <span className="menu-item-label">Восстановить из копии</span>
            <span className="menu-item-hint">
              берётся более свежее, выученное не пропадёт
            </span>
          </>
        ) : (
          "Восстановить из копии"
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json,.gz"
        className="vault-file"
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void restore(file);
        }}
      />
      {busy && (
        <p className="menu-foot" role="status">
          Восстанавливаем копию…
        </p>
      )}
      {error !== null && (
        <p className="menu-foot menu-foot--warn" role="alert">
          {error}
        </p>
      )}
      {result !== null && (
        <p className="menu-foot" role="status">
          Восстановлено: карточек {result.cards}, прогресса {result.progress},
          записей журнала {result.reviews}
          {result.duplicateReviews > 0 &&
            ` (${result.duplicateReviews} уже были)`}
          .
          {result.unassignedReviews > 0 &&
            ` Старых записей без определённой колоды: ${result.unassignedReviews}. Они сохранены, но не учитываются в дневных лимитах.`}
        </p>
      )}
    </>
  );
}
