import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import {
  AppDatabase,
  setDatabase,
  importDeck,
  type DeckFile,
} from "../storage";
import { makeCard } from "../srs/testing";
import { bootstrap } from "./bootstrap";

const opened: AppDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setDatabase(null);
  for (const db of opened) {
    db.close();
    await db.delete();
  }
  opened.length = 0;
});

function deck(id: string): DeckFile {
  return {
    meta: {
      id,
      name: id,
      version: "v1",
      language: "en",
      card_type: "cloze",
      built_at: "2026-10-30T10:00:00.000Z",
      count: 1,
      chunks: ["cards-000.json"],
    },
    cards: [makeCard({ id: `c_${id}` })],
  };
}
function index(files: DeckFile[]) {
  return {
    decks: files.map(({ meta }) => ({
      id: meta.id,
      name: meta.name,
      version: meta.version,
      count: meta.count,
      path: `${meta.id}/deck.json`,
    })),
  };
}
async function database() {
  const db = new AppDatabase(`bootstrap-${opened.length}`);
  opened.push(db);
  await db.open();
  setDatabase(db);
  return db;
}
function fetcher(files: DeckFile[], broken?: string) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("index.json"))
      return { ok: true, status: 200, json: async () => index(files) };
    const file = files.find((file) => url.includes(`/${file.meta.id}/`))!;
    return {
      ok: true,
      status: 200,
      json: async () =>
        file.meta.id === broken
          ? {}
          : url.endsWith("deck.json")
            ? file.meta
            : file.cards,
    };
  });
}

it("повреждение первой колоды не мешает загрузить вторую", async () => {
  await database();
  const files = [deck("broken"), deck("healthy")];
  const request = fetcher(files, "broken");
  vi.stubGlobal("fetch", request);
  const result = await bootstrap();
  expect(result.decks.map((deck) => deck.id)).toEqual(["healthy"]);
  expect(request.mock.calls.some(([url]) => url.includes("/healthy/"))).toBe(
    true,
  );
  expect(result.error).toBeNull();
  expect(result.offline).toBe(true);
});

it("все исправные колоды импортируются независимо", async () => {
  await database();
  vi.stubGlobal("fetch", fetcher([deck("first"), deck("second")]));
  const result = await bootstrap();
  expect(result.decks.map((deck) => deck.id).sort()).toEqual([
    "first",
    "second",
  ]);
  expect(result.offline).toBe(false);
});

it("зависший каталог возвращает локальную колоду по общему тайм-ауту и отменяет запрос", async () => {
  const db = await database();
  await importDeck(db, deck("cached"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let signal: AbortSignal | undefined;
  const request = vi.fn((_: string, options?: RequestInit) => {
    signal = options?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", request);
  const pending = bootstrap(undefined, { timeoutMs: 50 });
  await new Promise(setImmediate);
  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;
  expect(result.decks.map((deck) => deck.id)).toEqual(["cached"]);
  expect(result.error).toBeNull();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("зависшее тело ответа не блокирует восстановление при пустой базе", async () => {
  await database();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    })),
  );
  const pending = bootstrap(undefined, { timeoutMs: 50 });
  await new Promise(setImmediate);
  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;
  expect(result.decks).toEqual([]);
  expect(result.error).toContain("время ожидания");
});

it("отмена запуска возвращает локальные данные и очищает таймер", async () => {
  const db = await database();
  await importDeck(db, deck("cached"));
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = bootstrap(undefined, { signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  expect((await pending).decks.map((deck) => deck.id)).toEqual(["cached"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("зависшая первая колода не мешает второй и ограничена тем же общим сроком", async () => {
  await database();
  const files = [deck("slow"), deck("healthy")];
  const normal = fetcher(files);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.includes("/slow/")
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
          })
        : normal(url),
    ),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = bootstrap(undefined, { timeoutMs: 50 });
  await new Promise(setImmediate);
  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;
  expect(result.decks.map((deck) => deck.id)).toEqual(["healthy"]);
  expect(result.error).toBeNull();
});

it("ответ после тайм-аута не запускает поздний импорт", async () => {
  const db = await database();
  await importDeck(db, deck("cached"));
  let finish: (value: unknown) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", request);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = bootstrap(undefined, { timeoutMs: 50 });
  await new Promise(setImmediate);
  await vi.advanceTimersByTimeAsync(50);
  expect((await pending).decks.map((deck) => deck.id)).toEqual(["cached"]);
  finish({ ok: true, status: 200, json: async () => index([deck("late")]) });
  await new Promise(setImmediate);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await db.decks.get("late")).toBeUndefined();
});

it("отказ базы возвращает понятную ошибку и разрешает повторный запуск", async () => {
  const db = new AppDatabase("bootstrap-failure");
  setDatabase(db);
  vi.spyOn(db, "open").mockRejectedValueOnce(new Error("database denied"));
  const result = await bootstrap();
  expect(result.decks).toEqual([]);
  expect(result.offline).toBe(false);
  expect(result.error).toContain("локальное хранилище");
  expect(result.error).toContain("database denied");
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("offline"));
  try {
    const retry = await bootstrap();
    expect(db.isOpen()).toBe(true);
    expect(retry.error).toContain("колода недоступна");
  } finally {
    fetcher.mockRestore();
    db.close();
    await db.delete();
  }
});
