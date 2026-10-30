import type { DeckCard } from "../srs";

/** Канонический JSON совпадает с Python: sort_keys=True, separators=(",", ":"). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const data = value as Record<string, unknown>;
    return `{${Object.keys(data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(data[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("значение не является JSON");
  return result;
}

export async function contentHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** В базе порядок по ID, в публикации — по позиции; принадлежность колоде не часть содержимого. */
export function deckContentHash(
  cards: readonly (DeckCard & { deckId?: string })[],
): Promise<string> {
  return contentHash(
    [...cards]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ deckId: _deckId, ...card }) => card),
  );
}

/** До введения integrity версия считалась SHA-1 только по этим пяти полям. */
export async function legacyDeckVersion(
  cards: readonly DeckCard[],
): Promise<string> {
  const text = [...cards]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map(
      (card) =>
        `${card.id}|${card.text}|${card.answer}|${card.translation || ""}|${card.note || ""}`,
    )
    .join("");
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 12);
}
