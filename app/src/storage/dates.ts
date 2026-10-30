import type {
  ProgressChange,
  StoredDeck,
  StoredProgress,
  StoredReview,
} from "./db";

/** Строковые индексы дат сравнимы только при едином представлении UTC. */
export function utcDate(value: string): string {
  const timestamp = Date.parse(value);
  // Миграция сохраняет старое повреждение для явной диагностики, не блокируя открытие базы.
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export function utcDeck(row: StoredDeck): StoredDeck {
  return {
    ...row,
    builtAt: utcDate(row.builtAt),
    importedAt: utcDate(row.importedAt),
  };
}
export function utcProgress(row: StoredProgress): StoredProgress {
  return {
    ...row,
    due: utcDate(row.due),
    lastReview: row.lastReview === null ? null : utcDate(row.lastReview),
    ...(row.buriedUntil == null
      ? {}
      : { buriedUntil: utcDate(row.buriedUntil) }),
  };
}
export function utcReview<T extends StoredReview>(row: T): T {
  return { ...row, reviewedAt: utcDate(row.reviewedAt) };
}
export function utcChange(row: ProgressChange): ProgressChange {
  return { ...row, changedAt: utcDate(row.changedAt) };
}
