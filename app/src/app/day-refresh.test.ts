import { afterEach, expect, it, vi } from "vitest";
import { dayRefreshDelay, watchDay } from "./day-refresh";

afterEach(() => vi.useRealTimers());
function environment() {
  return {
    events: new EventTarget(),
    visibility: Object.assign(new EventTarget(), {
      visibilityState: "visible",
    }),
  };
}

it("пересчёт происходит на границе местных суток", async () => {
  vi.useFakeTimers();
  const beforeMidnight = new Date(2026, 9, 29, 23, 59, 59, 500);
  vi.setSystemTime(beforeMidnight);
  expect(dayRefreshDelay(beforeMidnight)).toBe(500);
  const { events, visibility } = environment();
  const refresh = vi.fn(async () => {});
  const stop = watchDay(refresh, vi.fn(), events, visibility);
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledOnce();
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(refresh).toHaveBeenCalledOnce();
});

it("фокус и повторный запуск PWA обновляют сводку без перезагрузки", async () => {
  vi.useFakeTimers();
  const { events, visibility } = environment();
  const refresh = vi.fn(async () => {});
  const stop = watchDay(refresh, vi.fn(), events, visibility);
  events.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  events.dispatchEvent(new Event("collocations:resume"));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
});

it("сроки повторений проверяются и без переключения окон", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 29, 10));
  const { events, visibility } = environment();
  const refresh = vi.fn(async () => {});
  const stop = watchDay(refresh, vi.fn(), events, visibility);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce();
  stop();
});

it("возвращение из скрытого окна обновляет счётчики", async () => {
  vi.useFakeTimers();
  const { events, visibility } = environment();
  visibility.visibilityState = "hidden";
  const refresh = vi.fn(async () => {}),
    stop = watchDay(refresh, vi.fn(), events, visibility);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).not.toHaveBeenCalled();
  visibility.visibilityState = "visible";
  visibility.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledOnce();
  stop();
});

it("повторные события не создают параллельные чтения; ошибки обрабатываются", async () => {
  vi.useFakeTimers();
  const { events, visibility } = environment();
  let fail!: (error: Error) => void;
  const refresh = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    ),
    error = vi.fn();
  const stop = watchDay(refresh, error, events, visibility);
  events.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  events.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledOnce();
  fail(new Error("read failed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledOnce();
  stop();
});
