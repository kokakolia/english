import { useEffect, useState, type ReactNode } from "react";
import { claimInstance, type InstanceClaim } from "../app/instance";

/** База и контроллер даже не открываются, пока другое окно держит блокировку. */
export function InstanceGate({ children }: { children: ReactNode }) {
  const [claim, setClaim] = useState<InstanceClaim | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    void claimInstance(navigator.locks).then((result) => {
      if (result.kind === "acquired") release = result.release;
      if (cancelled) {
        release?.();
        return;
      }
      setClaim(result);
    });
    // При восстановлении страницы из back/forward cache проверяем владение заново.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      cancelled = true;
      release?.();
      window.removeEventListener("pageshow", onShow);
    };
  }, [attempt]);

  if (claim?.kind === "acquired") return children;
  return (
    <main className="app">
      <section className="screen" aria-live="polite">
        {claim === null ? (
          <p>Проверяем запуск…</p>
        ) : (
          <>
            <h1 className="display">
              {claim.kind === "busy"
                ? "Приложение уже открыто"
                : "Не удалось открыть приложение"}
            </h1>
            <p>
              {claim.kind === "busy"
                ? "Продолжите занятие в уже открытом окне. Чтобы работать здесь, сначала закройте другое окно приложения или вкладку с ним."
                : claim.kind === "unsupported"
                  ? "Этот браузер не поддерживает безопасный запуск одного экземпляра. Откройте приложение в актуальном Chrome или Edge."
                  : "Браузер не разрешил проверить, открыто ли приложение в другом окне. Повторите попытку."}
            </p>
            <button
              type="button"
              className="pill"
              onClick={() => {
                setClaim(null);
                setAttempt((value) => value + 1);
              }}
            >
              {claim.kind === "busy" ? "Проверить снова" : "Повторить попытку"}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
