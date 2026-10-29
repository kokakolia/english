/**
 * Проверка ядра на настоящей колоде.
 *
 * Модульные тесты работают на выдуманных карточках и потому не поймают
 * рассогласования между пайплайном и приложением: изменится формат поля —
 * тесты останутся зелёными, а приложение сломается. Здесь берётся ровно тот
 * файл, который собирает пайплайн.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildQueue, familyKey } from "./queue";
import type { DeckCard } from "./types";

const DECK_DIR = new URL("../../../decks/en-collocations/", import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DECK_DIR), "utf-8")) as T;
}

interface DeckMeta {
  id: string;
  version: string;
  count: number;
  chunks: string[];
}

const meta = readJson<DeckMeta>("deck.json");
const cards: DeckCard[] = meta.chunks.flatMap((chunk) =>
  readJson<DeckCard[]>(chunk),
);

describe("колода из пайплайна", () => {
  it("собрана целиком", () => {
    expect(cards).toHaveLength(meta.count);
    expect(new Set(cards.map((card) => card.id)).size).toBe(meta.count);
  });

  it("у каждой карточки есть всё, что нужно для показа", () => {
    for (const card of cards) {
      expect(card.text).toContain("___");
      expect(card.answer.length).toBeGreaterThan(0);
      expect(card.answers.length).toBeGreaterThan(0);
      expect(card.hint.length).toBeGreaterThan(0);
    }
  });

  it("подстановка ответа восстанавливает исходное предложение", () => {
    for (const card of cards) {
      const restored = card.text.replace("___", card.answer);
      expect(restored).not.toContain("___");
    }
  });
});

describe("формы ответа для экспорта", () => {
  it("содержат точную форму из предложения", () => {
    expect(
      cards
        .filter((card) => !card.answers.includes(card.answer))
        .map((card) => card.id),
    ).toEqual([]);
  });
});

describe("очередь на настоящей колоде", () => {
  const now = new Date("2026-05-01T09:00:00Z");

  it("первый день даёт ровно дневную порцию новых карточек", () => {
    const queue = buildQueue({
      cards,
      progress: new Map(),
      settings: { newPerDay: 15, siblingGap: 4 },
      now,
    });
    expect(queue.counts.fresh).toBe(15);
    expect(queue.backlog).toBe(0);
  });

  it("на реальном материале сиблинги разводятся", () => {
    // Это не гарантировано теоретически: если в дневной порции слишком много
    // карточек одного гнезда, развести их нечем. Проверяем, что порядок
    // изучения такой порции не создаёт.
    const queue = buildQueue({
      cards,
      progress: new Map(),
      settings: { newPerDay: 30, siblingGap: 4 },
      now,
    });

    const lastSeen = new Map<string, number>();
    let violations = 0;
    queue.cards.forEach((card, index) => {
      const previous = lastSeen.get(familyKey(card));
      if (previous !== undefined && index - previous <= 4) violations += 1;
      lastSeen.set(familyKey(card), index);
    });
    expect(violations).toBe(0);
  });
});
