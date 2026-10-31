/** Ближайшее будущее занятие при неизменном прогрессе и дневных лимитах. */
import { nextDayStart } from "./scheduler";
import { DEFAULT_SETTINGS, type BuildQueueInput } from "./queue";
import type { CardProgress } from "./types";

export function nextAvailableAt({
  cards,
  progress,
  now,
  settings,
  studiedToday = { fresh: 0, review: 0 },
}: BuildQueueInput): string | null {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  const time = now.getTime(),
    midnight = nextDayStart(now).getTime();
  const rows: (CardProgress | undefined)[] = cards.map((card) =>
    progress instanceof Map ? progress.get(card.id) : progress[card.id],
  );
  function visibleAt(row: CardProgress | undefined) {
    return row?.suspended
      ? Infinity
      : Math.max(time, row?.buriedUntil ? Date.parse(row.buriedUntil) : time);
  }
  let earliest = Infinity,
    nextNew = Infinity;
  for (const row of rows) {
    const visible = visibleAt(row);
    if (!Number.isFinite(visible)) continue;
    if (!row || row.state === "new") {
      if (config.newPerDay > 0)
        nextNew = Math.min(
          nextNew,
          Math.max(
            visible,
            studiedToday.fresh >= config.newPerDay ? midnight : time,
          ),
        );
    } else if (row.state === "review") {
      if (config.reviewsPerDay > 0) {
        const candidate = Math.max(
          visible,
          Date.parse(row.due),
          studiedToday.review >= config.reviewsPerDay ? midnight : time,
        );
        if (candidate > time) earliest = Math.min(earliest, candidate);
      }
    } else {
      // Короткие повторы не расходуют лимит обычных повторений.
      const candidate = Math.max(visible, Date.parse(row.due));
      if (candidate > time) earliest = Math.min(earliest, candidate);
    }
  }
  function newAllowedAt(at: number) {
    const used = at < midnight ? studiedToday.review : 0;
    const budget = Math.max(0, config.reviewsPerDay - used);
    const dueReviews = rows.filter(
      (row) =>
        row?.state === "review" &&
        visibleAt(row) <= at &&
        Date.parse(row.due) <= at,
    ).length;
    return dueReviews <= budget;
  }
  if (Number.isFinite(nextNew)) {
    // Без ответов завал может уменьшиться только из-за сброса дневного лимита.
    if (!newAllowedAt(nextNew) && nextNew < midnight) nextNew = midnight;
    if (nextNew > time && newAllowedAt(nextNew))
      earliest = Math.min(earliest, nextNew);
  }
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}
