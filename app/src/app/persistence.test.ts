import { describe, expect, it } from "vitest";

import { formatBytes, storageAdvice, storageAtRisk, type StorageStatus } from "./persistence";

function status(patch: Partial<StorageStatus> = {}): StorageStatus {
  return { supported: true, persisted: true, usage: null, quota: null, ...patch };
}

describe("совет о хранилище", () => {
  it("молчит, пока ответ браузера не получен", () => {
    expect(storageAdvice(null, false)).toBeNull();
  });

  it("всё в порядке, когда разрешение есть", () => {
    expect(storageAdvice(status(), false)).toBe("ok");
    expect(storageAdvice(status(), true)).toBe("ok");
  });

  it("предлагает установку тому, кто ещё не установил", () => {
    expect(storageAdvice(status({ persisted: false }), false)).toBe("install");
  });

  it("не предлагает установить то, что уже установлено", () => {
    // Ради этой строки совет и вынесен из вёрстки: первая версия советовала
    // установку всем подряд, в том числе из установленного приложения.
    expect(storageAdvice(status({ persisted: false }), true)).toBe("stuck");
  });

  it("отдельный ответ там, где браузер вообще не умеет постоянное хранилище", () => {
    expect(storageAdvice(status({ supported: false, persisted: false }), false)).toBe(
      "unsupported",
    );
    // Установка ничего не изменит, если возможности нет в принципе.
    expect(storageAdvice(status({ supported: false, persisted: false }), true)).toBe(
      "unsupported",
    );
  });
});

describe("метка на кнопке меню", () => {
  it("стоит ровно тогда, когда прогресс может быть вытеснен", () => {
    expect(storageAtRisk(status())).toBe(false);
    expect(storageAtRisk(status({ persisted: false }))).toBe(true);
    // Пока ответа нет, пугать нечем.
    expect(storageAtRisk(null)).toBe(false);
  });
});

describe("размер по-человечески", () => {
  it("переводит байты в привычные единицы", () => {
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(2048)).toBe("2 КБ");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5,0 МБ");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3,0 ГБ");
  });
});
