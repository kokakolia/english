import { describe, expect, it, vi } from "vitest";

import { gunzipIfNeeded, gzip, saveBackupFile } from "./backup-file";
import { AppDatabase } from "../storage/db";
import { backupFileName } from "../storage/backup";

describe("сжатие копии", () => {
  it("сжатое читается обратно без потерь", async () => {
    const text = JSON.stringify({
      progress: Array.from({ length: 500 }, (_, i) => ({
        cardId: `c_${i}`,
        reps: i,
      })),
    });
    const packed = await gzip(text);

    expect(await gunzipIfNeeded(packed)).toBe(text);
  });

  it("на однородных данных выигрыш заметный", async () => {
    const text = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({
        cardId: `c_${i}`,
        state: "review",
        reps: 3,
      })),
    );
    const packed = await gzip(text);

    // Ради этого всё и затевалось: копия прогресса ужимается в разы.
    expect(packed.size).toBeLessThan(text.length / 3);
  });

  it("несжатая копия читается как есть", async () => {
    // Старые файлы лежат обычным JSON, и открываться они обязаны.
    const text = '{"format":"collocation-srs-backup"}';
    expect(await gunzipIfNeeded(new Blob([text]))).toBe(text);
  });

  it("пустой файл не притворяется сжатым", async () => {
    expect(await gunzipIfNeeded(new Blob([]))).toBe("");
  });

  it("слишком большой файл отклоняется до чтения", async () => {
    const file = new Blob(["12345"]);
    const read = vi.spyOn(file, "slice");
    await expect(
      gunzipIfNeeded(file, { fileBytes: 4, unpackedBytes: 100 }),
    ).rejects.toThrow("Файл копии слишком большой");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "лимит распакованных байтов действует и для gzip: %s",
    async (packed) => {
      const text = "Я".repeat(5000);
      const file = packed ? await gzip(text) : new Blob([text]);
      await expect(
        gunzipIfNeeded(file, { fileBytes: 20000, unpackedBytes: 9999 }),
      ).rejects.toThrow("Распакованная копия слишком большая");
      expect(
        await gunzipIfNeeded(file, { fileBytes: 20000, unpackedBytes: 10000 }),
      ).toBe(text);
    },
  );

  it("чтение прекращается сразу при превышении лимита", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(64));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const file = new Blob(["plain"]);
    vi.spyOn(file, "stream").mockReturnValue(stream);
    await expect(
      gunzipIfNeeded(file, { fileBytes: 100, unpackedBytes: 100 }),
    ).rejects.toThrow("Распакованная копия слишком большая");
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("повреждённый gzip отклоняется", async () => {
    await expect(
      gunzipIfNeeded(new Blob([new Uint8Array([0x1f, 0x8b, 0, 0])])),
    ).rejects.toThrow();
  });

  it("сжатие не создаёт файл, который нельзя распаковать из-за лимита JSON", async () => {
    await expect(
      gzip("Я".repeat(500), { fileBytes: 10000, unpackedBytes: 999 }),
    ).rejects.toThrow("Распакованная копия слишком большая");
  });

  it("сжатие учитывает предел размера самого файла", async () => {
    await expect(
      gzip("small", { fileBytes: 1, unpackedBytes: 100 }),
    ).rejects.toThrow("Файл копии слишком большой");
  });
});

it("снимки одной секунды и одного мгновения имеют разные имена", () => {
  const now = new Date("2026-10-30T10:00:00.100Z");
  const names = Array.from({ length: 100 }, () =>
    backupFileName(now, "json.gz"),
  );
  names.push(backupFileName(new Date("2026-10-30T10:00:00.900Z"), "json.gz"));
  expect(new Set(names).size).toBe(101);
  expect(names[0]).toMatch(
    /^collocations-backup-2026-10-30-10-00-00-100-[0-9a-f-]{36}\.json\.gz$/,
  );
});

it("выбранная папка сохраняет обе копии одной секунды", async () => {
  const db = new AppDatabase("backup-filename-test");
  const files = new Map<string, Blob>();
  const folder = {
    name: "copies",
    getFileHandle: async (name: string) => ({
      createWritable: async () =>
        new WritableStream<Blob>({
          write(value) {
            files.set(name, value);
          },
        }),
    }),
  };
  vi.spyOn(db.settings, "get").mockResolvedValue({
    key: "backupFolder",
    value: folder,
  });
  vi.stubGlobal("window", { showDirectoryPicker: vi.fn() });
  try {
    const first = backupFileName(new Date("2026-10-30T10:00:00.100Z"));
    const second = backupFileName(new Date("2026-10-30T10:00:00.900Z"));
    await saveBackupFile(db, first, new Blob(["first"]));
    await saveBackupFile(db, second, new Blob(["second"]));
    expect(files.size).toBe(2);
    expect(await files.get(first)!.text()).toBe("first");
    expect(await files.get(second)!.text()).toBe("second");
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    db.close();
  }
});
