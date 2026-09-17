import { describe, expect, it } from "vitest";

import { makeCard } from "../srs/testing";
import { DeckLoadError, loadDeckFile, loadDeckIndex, type FetchLike } from "./loader";

/** Заглушка сети: отдаёт заранее подготовленные ответы по адресу. */
function stubFetch(files: Record<string, unknown>): FetchLike {
  return async (url: string) => {
    if (!(url in files)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => files[url] };
  };
}

const cards = [makeCard({ id: "c_1" }), makeCard({ id: "c_2" }), makeCard({ id: "c_3" })];

const meta = {
  id: "en-collocations",
  name: "Английские коллокации",
  version: "abc123",
  language: "en",
  card_type: "cloze",
  built_at: "2026-04-01T00:00:00Z",
  count: 3,
  chunks: ["cards-000.json", "cards-001.json"],
};

describe("загрузка колоды", () => {
  it("собирает карточки из всех частей", async () => {
    const fetchImpl = stubFetch({
      "/decks/en-collocations/deck.json": meta,
      "/decks/en-collocations/cards-000.json": cards.slice(0, 2),
      "/decks/en-collocations/cards-001.json": cards.slice(2),
    });

    const file = await loadDeckFile("/decks/en-collocations", fetchImpl);
    expect(file.cards.map((card) => card.id)).toEqual(["c_1", "c_2", "c_3"]);
    expect(file.meta.version).toBe("abc123");
  });

  it("не импортирует недокачанную колоду", async () => {
    // Половина карточек хуже, чем отказ: пользователь решит, что колода
    // маленькая, и не поймёт, что материал пропал.
    const fetchImpl = stubFetch({
      "/decks/en-collocations/deck.json": meta,
      "/decks/en-collocations/cards-000.json": cards.slice(0, 2),
      "/decks/en-collocations/cards-001.json": [],
    });

    await expect(loadDeckFile("/decks/en-collocations", fetchImpl)).rejects.toBeInstanceOf(
      DeckLoadError,
    );
  });

  it("сообщает о недоступном файле", async () => {
    const fetchImpl = stubFetch({});
    await expect(loadDeckFile("/decks/missing", fetchImpl)).rejects.toThrow(/404|код/);
  });

  it("сообщает об отказе сети, а не падает", async () => {
    const broken: FetchLike = async () => {
      throw new Error("сеть недоступна");
    };
    await expect(loadDeckFile("/decks/any", broken)).rejects.toBeInstanceOf(DeckLoadError);
  });

  it("читает перечень колод", async () => {
    const fetchImpl = stubFetch({
      "/decks/index.json": {
        decks: [
          { id: "en-collocations", name: "Английские коллокации", version: "abc123", count: 3, path: "en-collocations/deck.json" },
        ],
      },
    });

    const index = await loadDeckIndex("/decks", fetchImpl);
    expect(index).toHaveLength(1);
    expect(index[0]?.id).toBe("en-collocations");
  });

  it("не принимает перечень без списка колод", async () => {
    const fetchImpl = stubFetch({ "/decks/index.json": {} });
    await expect(loadDeckIndex("/decks", fetchImpl)).rejects.toBeInstanceOf(DeckLoadError);
  });

  it("работает и с адресом со слэшем на конце", async () => {
    const fetchImpl = stubFetch({
      "/decks/en-collocations/deck.json": { ...meta, chunks: ["cards-000.json"], count: 3 },
      "/decks/en-collocations/cards-000.json": cards,
    });
    const file = await loadDeckFile("/decks/en-collocations/", fetchImpl);
    expect(file.cards).toHaveLength(3);
  });
});
