import { describe, expect, it } from "vitest";

import { gunzipIfNeeded, gzip } from "./backup-file";

describe("сжатие копии", () => {
  it("сжатое читается обратно без потерь", async () => {
    const text = JSON.stringify({ progress: Array.from({ length: 500 }, (_, i) => ({ cardId: `c_${i}`, reps: i })) });
    const packed = await gzip(text);

    expect(await gunzipIfNeeded(packed)).toBe(text);
  });

  it("на однородных данных выигрыш заметный", async () => {
    const text = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({ cardId: `c_${i}`, state: "review", reps: 3 })),
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
});
