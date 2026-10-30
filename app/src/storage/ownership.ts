import type { AppDatabase } from "./db";

export class DeckOwnershipError extends Error {}

type OwnedCard = { cardId: string; deckId: string };

/** В текущей схеме cardId глобален: разные колоды не могут владеть им одновременно. */
export function assertOwners(rows: OwnedCard[]): void {
  const owners = new Map<string, string>();
  for (const row of rows) {
    const owner = owners.get(row.cardId);
    if (owner !== undefined && owner !== row.deckId) {
      throw new DeckOwnershipError(
        `Колоды «${owner}» и «${row.deckId}» содержат одинаковые карточки. Их нельзя хранить одновременно. Данные не изменены.`,
      );
    }
    owners.set(row.cardId, row.deckId);
  }
}

/** Вызывать внутри транзакции с cards, progress, changes и reviews. */
export async function assertAvailableOwners(
  db: AppDatabase,
  incoming: OwnedCard[],
): Promise<void> {
  const ids = [...new Set(incoming.map((row) => row.cardId))];
  const [cards, progress, changes] = await Promise.all([
    db.cards.bulkGet(ids),
    db.progress.bulkGet(ids),
    db.changes.bulkGet(ids),
  ]);
  // Обычно владелец уже закреплён карточкой/прогрессом/действием. У старой
  // сироты может оставаться только журнал — он тоже сохраняет владельца.
  const orphans = ids.filter(
    (_, index) => !cards[index] && !progress[index] && !changes[index],
  );
  const history =
    orphans.length > 0
      ? await db.reviews.where("cardId").anyOf(orphans).toArray()
      : [];
  assertOwners([
    ...incoming,
    ...cards.flatMap((row) =>
      row ? [{ cardId: row.id, deckId: row.deckId }] : [],
    ),
    ...progress.flatMap((row) => (row ? [row] : [])),
    ...changes.flatMap((row) => (row ? [row] : [])),
    ...history.flatMap((row) =>
      typeof row.deckId === "string"
        ? [{ cardId: row.cardId, deckId: row.deckId }]
        : [],
    ),
  ]);
}
