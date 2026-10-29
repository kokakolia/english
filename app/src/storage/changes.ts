import type { AppDatabase } from "./db";

/** Вызывать внутри транзакции, включающей changes. Равные часы не теряют порядок. */
export async function markChanged(
  db: AppDatabase,
  cardId: string,
  deckId: string,
  now: Date,
): Promise<void> {
  const previous = await db.changes.get(cardId);
  const time = Math.max(
    now.getTime(),
    previous ? Date.parse(previous.changedAt) + 1 : 0,
  );
  await db.changes.put({
    cardId,
    deckId,
    changedAt: new Date(time).toISOString(),
  });
}
