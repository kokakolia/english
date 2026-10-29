export function dayRefreshDelay(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1, Math.min(60_000, midnight.getTime() - now.getTime()));
}

/** Пересчитывает сроки в открытом окне, не создавая параллельных чтений. */
export function watchDay(
  refresh: () => Promise<void>,
  onError: (cause: unknown) => void,
  events: EventTarget = window,
  visibility: EventTarget & { visibilityState: string } = document,
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(run, dayRefreshDelay(new Date()));
  }
  function run() {
    if (stopped || running) return;
    if (visibility.visibilityState === "hidden") {
      schedule();
      return;
    }
    running = true;
    void Promise.resolve()
      .then(() => {
        if (!stopped) return refresh();
      })
      .catch((cause) => {
        if (!stopped) onError(cause);
      })
      .finally(() => {
        running = false;
        schedule();
      });
  }
  events.addEventListener("focus", run);
  events.addEventListener("collocations:resume", run);
  visibility.addEventListener("visibilitychange", run);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    events.removeEventListener("focus", run);
    events.removeEventListener("collocations:resume", run);
    visibility.removeEventListener("visibilitychange", run);
  };
}
