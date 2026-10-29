import { afterEach, expect, it, vi } from "vitest";
import { createUpdateSafety } from "./update-safety";
import { watchForUpdates } from "./updates";

afterEach(() => vi.unstubAllGlobals());

it("обновление ждёт выхода из занятия", () => {
  const reload = vi.fn(),
    safety = createUpdateSafety(reload);
  safety.request();
  expect(reload).not.toHaveBeenCalled();
  safety.setSafe(true);
  expect(reload).toHaveBeenCalledOnce();
  safety.request();
  safety.setSafe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it("на экране дня обновление ждёт завершения всех операций", () => {
  const reload = vi.fn(),
    safety = createUpdateSafety(reload);
  safety.setSafe(true);
  const finishReview = safety.begin(),
    finishBackup = safety.begin();
  safety.request();
  finishReview();
  finishReview();
  expect(reload).not.toHaveBeenCalled();
  finishBackup();
  expect(reload).toHaveBeenCalledOnce();
});

it("завершение записи внутри занятия не разрешает перезагрузку", () => {
  const reload = vi.fn(),
    safety = createUpdateSafety(reload);
  const finish = safety.begin();
  safety.request();
  finish();
  expect(reload).not.toHaveBeenCalled();
  safety.setSafe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it("смена service worker запрашивает безопасное обновление", async () => {
  const reload = vi.fn(),
    safety = createUpdateSafety(reload);
  const update = vi.fn(async () => undefined);
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: {},
    ready: Promise.resolve({ update }),
  });
  vi.stubGlobal("navigator", { serviceWorker });
  watchForUpdates(safety);
  serviceWorker.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  safety.setSafe(true);
  expect(reload).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(update).toHaveBeenCalledOnce();
});

it("первая установка service worker не перезагружает страницу", () => {
  const reload = vi.fn(),
    safety = createUpdateSafety(reload);
  safety.setSafe(true);
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: null,
    ready: new Promise(() => {}),
  });
  vi.stubGlobal("navigator", { serviceWorker });
  watchForUpdates(safety);
  serviceWorker.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
});
