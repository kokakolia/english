import type { CardProgress } from "./types";

/** Согласованное состояние FSRS, которое можно безопасно передать планировщику. */
export function validSchedule(value: unknown): value is CardProgress {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  const date = (s: unknown): s is string =>
    typeof s === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(s) &&
    Number.isFinite(Date.parse(s));
  if (
    typeof row.cardId !== "string" ||
    !row.cardId.trim() ||
    !date(row.due) ||
    !finite(row.stability) ||
    !finite(row.difficulty) ||
    row.difficulty > 10 ||
    !finite(row.elapsedDays) ||
    !finite(row.scheduledDays) ||
    !finite(row.reps) ||
    !Number.isSafeInteger(row.reps) ||
    !finite(row.lapses) ||
    !Number.isSafeInteger(row.lapses) ||
    row.lapses > row.reps
  )
    return false;
  if (row.state === "new") {
    return (
      row.lastReview === null &&
      row.reps === 0 &&
      row.lapses === 0 &&
      row.stability === 0 &&
      row.difficulty === 0 &&
      row.elapsedDays === 0 &&
      row.scheduledDays === 0
    );
  }
  return (
    typeof row.state === "string" &&
    ["learning", "review", "relearning"].includes(row.state) &&
    row.stability > 0 &&
    row.difficulty >= 1 &&
    row.reps > 0 &&
    date(row.lastReview) &&
    Date.parse(row.due) >= Date.parse(row.lastReview)
  );
}
