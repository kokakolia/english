/** Один владелец базы среди окон PWA и вкладок этого профиля браузера. */
export type InstanceClaim =
  | { kind: "acquired"; release: () => void }
  | { kind: "busy" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export function claimInstance(
  locks: LockManager | undefined,
): Promise<InstanceClaim> {
  if (!locks || typeof locks.request !== "function")
    return Promise.resolve({ kind: "unsupported" });
  return new Promise((resolve) => {
    try {
      void locks
        .request(
          "collocation-srs-active-instance",
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              resolve({ kind: "busy" });
              return;
            }
            await new Promise<void>((release) =>
              resolve({ kind: "acquired", release }),
            );
          },
        )
        .catch((cause) => resolve({ kind: "error", message: String(cause) }));
    } catch (cause) {
      resolve({ kind: "error", message: String(cause) });
    }
  });
}
