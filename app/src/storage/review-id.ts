import type { ReviewEntry } from "../srs/types";

/** Старые копии получают воспроизводимые ID без локального номера строки.
 * Пометка отмены не меняет идентичность события. Полностью одинаковые
 * старые события различаются порядковым номером внутри группы.
 */
export function withReviewIds<T extends ReviewEntry>(rows: T[]): (T & { eventId: string })[] {
  const occurrences = new Map<string, number>();
  return rows.map(row => {
    const key = JSON.stringify([row.cardId, row.reviewedAt, row.grade, row.stateBefore,
      row.elapsedDays, row.scheduledDays, row.typed ?? null, row.verdict ?? null, row.durationMs ?? null]);
    const ordinal = occurrences.get(key) ?? 0;
    occurrences.set(key, ordinal + 1);
    return { ...row, eventId: row.eventId ?? `legacy:${key}:${ordinal}` };
  });
}
