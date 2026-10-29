import { describe, expect, it } from "vitest";
import { claimInstance } from "./instance";

function exclusiveLocks() {
  let held = false;
  const completed: Promise<unknown>[] = [];
  const locks = {
    request(
      _name: string,
      options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ) {
      expect(options.ifAvailable).toBe(true);
      const acquired = !held;
      if (acquired) held = true;
      const done = Promise.resolve()
        .then(() => callback(acquired ? ({} as Lock) : null))
        .finally(() => {
          if (acquired) held = false;
        });
      completed.push(done);
      return done;
    },
  } as unknown as LockManager;
  return { locks, completed };
}

describe("единственный активный экземпляр", () => {
  it("два одновременных запуска получают только одного владельца", async () => {
    const { locks, completed } = exclusiveLocks();
    const claims = await Promise.all([
      claimInstance(locks),
      claimInstance(locks),
    ]);
    expect(claims.map((value) => value.kind)).toEqual(["acquired", "busy"]);
    for (const claim of claims) if (claim.kind === "acquired") claim.release();
    await Promise.all(completed);
  });

  it("после освобождения второй экземпляр может запуститься", async () => {
    const { locks, completed } = exclusiveLocks();
    const first = await claimInstance(locks);
    expect((await claimInstance(locks)).kind).toBe("busy");
    if (first.kind === "acquired") first.release();
    await completed[0];
    const next = await claimInstance(locks);
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") next.release();
    await Promise.all(completed);
  });

  it("без API не разрешает небезопасный параллельный запуск", async () => {
    expect((await claimInstance(undefined)).kind).toBe("unsupported");
  });

  it("ошибка API становится сообщением, а не вечным ожиданием", async () => {
    const locks = {
      request: () => Promise.reject(new Error("denied")),
    } as unknown as LockManager;
    expect(await claimInstance(locks)).toMatchObject({
      kind: "error",
      message: "Error: denied",
    });
  });

  it("синхронный отказ API тоже обрабатывается", async () => {
    const locks = {
      request: () => {
        throw new Error("denied");
      },
    } as unknown as LockManager;
    expect((await claimInstance(locks)).kind).toBe("error");
  });
});
