/** Обновление применяется на экране дня после завершения всех операций. */
export function createUpdateSafety(reload: () => void) {
  let safe = false;
  let pending = false;
  let reloading = false;
  const activities = new Set<symbol>();
  function check() {
    if (!safe || !pending || activities.size > 0 || reloading) return;
    reloading = true;
    reload();
  }
  return {
    setSafe(value: boolean) { safe = value; check(); },
    request() { pending = true; check(); },
    begin() {
      const token = Symbol(); activities.add(token);
      return () => { activities.delete(token); check(); };
    },
  };
}

export const updateSafety = createUpdateSafety(() => window.location.reload());
