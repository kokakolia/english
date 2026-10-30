import type { AppDatabase, StoredReview } from "./db";

export interface ReviewOwnerSnapshot {
  decks: readonly { id: string }[];
  cards: readonly { id: string; deckId: string }[];
  progress: readonly { cardId: string; deckId: string }[];
  changes?: readonly { cardId: string; deckId: string }[];
}

export async function unassignedReviewCount(db: AppDatabase): Promise<number> {
  return db.transaction(
    "r",
    db.reviews,
    async () =>
      (await db.reviews.count()) -
      (await db.reviews.where("deckId").above("").count()),
  );
}

/** Использует только доказательства из самого снимка. null никогда не переопределяется. */
export function withReviewOwners<T extends StoredReview>(
  rows: readonly T[],
  snapshot: ReviewOwnerSnapshot,
): (T & { deckId: string | null })[] {
  const claims = new Map<string, Set<string>>();
  for (const row of [
    ...snapshot.cards.map((card) => ({ cardId: card.id, deckId: card.deckId })),
    ...snapshot.progress,
    ...(snapshot.changes ?? []),
  ]) {
    const owners = claims.get(row.cardId) ?? new Set<string>();
    owners.add(row.deckId);
    claims.set(row.cardId, owners);
  }
  return rows.map((row) => {
    if (row.deckId !== undefined) return { ...row, deckId: row.deckId };
    const owners = claims.get(row.cardId);
    const deckId =
      owners?.size === 1
        ? [...owners][0]!
        : owners?.size
          ? null
          : snapshot.decks.length === 1
            ? snapshot.decks[0]!.id
            : null;
    return { ...row, deckId };
  });
}
