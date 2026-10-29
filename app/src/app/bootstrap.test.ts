import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { AppDatabase, setDatabase } from "../storage";
import { bootstrap } from "./bootstrap";

afterEach(() => { vi.restoreAllMocks(); setDatabase(null); });

it("отказ базы возвращает понятную ошибку и разрешает повторный запуск", async () => {
  const db = new AppDatabase("bootstrap-failure");
  setDatabase(db);
  vi.spyOn(db, "open").mockRejectedValueOnce(new Error("database denied"));
  const result = await bootstrap();
  expect(result.decks).toEqual([]);
  expect(result.offline).toBe(false);
  expect(result.error).toContain("локальное хранилище");
  expect(result.error).toContain("database denied");
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  try {
    const retry = await bootstrap();
    expect(db.isOpen()).toBe(true);
    expect(retry.error).toContain("колода недоступна");
  } finally { fetcher.mockRestore(); db.close(); await db.delete(); }
});
