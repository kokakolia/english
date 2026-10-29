import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { createScheduler } from "../srs";
import { makeCard } from "../srs/testing";
import { AppDatabase, importDeck, exportBackup, restoreBackup, recordReview, undoReview, setDatabase, type DeckFile } from "./index";
import { bootstrap } from "../app/bootstrap";
import { loadDeckFile, DeckLoadError } from "./loader";
import { contentHash } from "./integrity";

const NOW = new Date("2026-10-29T10:00:00Z"), DAY = 86400000;
const scheduler = createScheduler({ enableFuzz: false });
const card = makeCard();
const databases: AppDatabase[] = [];
async function database() { const db = new AppDatabase(`durability-${databases.length}`); databases.push(db); await db.open(); return db; }
function file(version = "v1", cards = [card], builtAt = NOW): DeckFile {
  return { meta: { id: "audit", name: "Audit", version, language: "en", card_type: "cloze", built_at: builtAt.toISOString(), count: cards.length, chunks: ["cards-000.json"] }, cards };
}
afterEach(async () => { setDatabase(null); vi.unstubAllGlobals(); for (const db of databases) { db.close(); await db.delete(); } databases.length = 0; });

it("старая сборка приложения не отменяет восстановление новой колоды", async () => {
  const db = await database(); setDatabase(db); const added = makeCard();
  await importDeck(db, file("v2", [card, added], new Date(NOW.getTime() + DAY)));
  await recordReview(db, { cardId: added.id, deckId: "audit", grade: "easy", now: NOW, scheduler });
  await restoreBackup(db, await exportBackup(db));
  const old = file();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith("index.json") ?
    { decks: [{ id: "audit", name: "Audit", version: "v1", count: 1, path: "audit/deck.json" }] } : url.endsWith("deck.json") ? old.meta : old.cards })));
  const result = await bootstrap();
  expect(result.imported).toMatchObject({ skipped: true, reason: "older-version", version: "v2" });
  expect(await db.cards.get(added.id)).toBeDefined(); expect(await db.progress.get(added.id)).toBeDefined();
});

it.each(["older-bundle", "empty-index"])("облегчённая новая копия без карточек не выдаётся за готовую: %s", async source => {
  const original = await database();
  await importDeck(original, file("v2", [card], new Date(NOW.getTime() + DAY)));
  await recordReview(original, { cardId: card.id, deckId: "audit", grade: "easy", now: NOW, scheduler });
  const copy = await exportBackup(original, { includeCards: false });
  const target = await database(); setDatabase(target);
  await restoreBackup(target, copy);
  const old = file();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith("index.json") ?
    { decks: source === "empty-index" ? [] : [{ id: "audit", name: "Audit", version: "v1", count: 1, path: "audit/deck.json" }] } : url.endsWith("deck.json") ? old.meta : old.cards })));
  const result = await bootstrap();
  expect(result.decks).toEqual([]);
  expect(result.error).toContain("полную резервную копию");
  expect(await target.cards.count()).toBe(0);
  expect((await target.decks.get("audit"))?.version).toBe("v2");
  expect(await target.progress.get(card.id)).toBeDefined();
});

it("понижение версии требует явного параметра даже с force", async () => {
  const db = await database(); await importDeck(db, file("v2", [card], new Date(NOW.getTime() + DAY)));
  expect((await importDeck(db, file(), { force: true })).reason).toBe("older-version");
  expect((await importDeck(db, file(), { allowDowngrade: true })).skipped).toBe(false);
});

it("разные версии с одинаковой датой не заменяют друг друга автоматически", async () => {
  const db = await database(); await importDeck(db, file("restored"));
  const result = await importDeck(db, file("bundled"));
  expect(result).toMatchObject({ skipped: true, reason: "version-conflict", version: "restored" });
});

it("изменённая часть с прежней контрольной суммой отклоняется", async () => {
  const data = file(); const hash = await contentHash(data.cards);
  data.meta.integrity = { algorithm: "sha256-canonical-json-v1", chunks: { "cards-000.json": hash } };
  data.meta.version = hash.slice(0, 12);
  const altered = [{ ...card, text: "We found a ___ in the altered sentence." }];
  await expect(loadDeckFile("/audit", async url => ({ ok: true, status: 200, json: async () => url.endsWith("deck.json") ? data.meta : altered }))).rejects.toBeInstanceOf(DeckLoadError);
});

it("целые части с неверной общей версией тоже отклоняются", async () => {
  const data = file(); data.meta.integrity = { algorithm: "sha256-canonical-json-v1", chunks: { "cards-000.json": await contentHash(data.cards) } };
  await expect(loadDeckFile("/audit", async url => ({ ok: true, status: 200, json: async () => url.endsWith("deck.json") ? data.meta : data.cards }))).rejects.toThrow(/версии/);
});

it("новые имена файлов не допускают удаление раздела integrity", async () => {
  const data = file(); data.meta.chunks = ["cards-000-1234567890abcdef.json"];
  await expect(loadDeckFile("/audit", async url => ({ ok: true, status: 200, json: async () => url.endsWith("deck.json") ? data.meta : data.cards }))).rejects.toThrow(/метаданные/);
});

it("реальная опубликованная колода проходит проверку Python/JS хэшей", async () => {
  const { readFile } = await import("node:fs/promises"); const root = new URL("../../../decks/en-collocations/", import.meta.url);
  const loaded = await loadDeckFile("/audit", async url => ({ ok: true, status: 200, json: async () => JSON.parse(await readFile(new URL(url.split("/").at(-1)!, root), "utf8")) }));
  expect(loaded.cards).toHaveLength(1008); expect(loaded.meta.integrity).toBeDefined();
});

it("оценки с одинаковым временем и отмена сохраняются при повторном слиянии", async () => {
  const source = await database(); await importDeck(source, file());
  const first = await recordReview(source, { cardId: card.id, deckId: "audit", grade: "again", now: NOW, scheduler });
  await undoReview(source, { cardId: card.id, reviewId: first.reviewId, previous: first.previous, now: NOW });
  await recordReview(source, { cardId: card.id, deckId: "audit", grade: "easy", now: NOW, scheduler });
  const copy = await exportBackup(source), target = await database();
  await restoreBackup(target, copy, { mode: "merge" }); await restoreBackup(target, copy, { mode: "merge" });
  const rows = await target.reviews.toArray();
  expect(rows).toHaveLength(2); expect(rows.filter(row => !row.undone)).toHaveLength(1);
  expect(new Set(rows.map(row => row.eventId)).size).toBe(2);
});

it("старые копии без eventId сохраняют разные события одной миллисекунды", async () => {
  const source = await database(); await importDeck(source, file());
  for (const grade of ["again", "easy"] as const) await recordReview(source, { cardId: card.id, deckId: "audit", grade, now: NOW, scheduler });
  const copy = await exportBackup(source); copy.formatVersion = 2; copy.reviews = copy.reviews.map(({ eventId: _eventId, ...row }) => row);
  const target = await database(); await restoreBackup(target, copy); await restoreBackup(target, copy, { mode: "merge" });
  expect(await target.reviews.count()).toBe(2);
});

it("полностью одинаковые старые записи тоже не схлопываются", async () => {
  const source = await database(); await importDeck(source, file());
  for (let i = 0; i < 3; i++) await recordReview(source, { cardId: card.id, deckId: "audit", grade: "again", now: NOW, scheduler });
  const copy = await exportBackup(source); copy.formatVersion = 2; copy.reviews = copy.reviews.map(({ eventId: _eventId, ...row }) => row);
  const target = await database(); await restoreBackup(target, copy, { mode: "merge" }); await restoreBackup(target, copy, { mode: "merge" });
  expect(await target.reviews.count()).toBe(3);
});

it("миграция v2 назначает те же legacy ID, что импорт старой копии", async () => {
  const source = await database(); await importDeck(source, file());
  for (const grade of ["again", "easy"] as const) await recordReview(source, { cardId: card.id, deckId: "audit", grade, now: NOW, scheduler });
  const copy = await exportBackup(source); copy.formatVersion = 2; copy.reviews = copy.reviews.map(({ eventId: _eventId, ...row }) => row);
  const name = "durability-legacy"; const legacy = new Dexie(name);
  legacy.version(2).stores({ decks: "id, importedAt", cards: "id, deckId, position, headword, relation, band, cefr", progress: "cardId, deckId, due, state, [deckId+due]", reviews: "++id, cardId, reviewedAt, [cardId+reviewedAt]", settings: "key", changes: "cardId, deckId" });
  await legacy.open(); await legacy.table("decks").bulkPut(copy.decks); await legacy.table("cards").bulkPut(copy.cards); await legacy.table("reviews").bulkPut(copy.reviews); legacy.close();
  const upgraded = new AppDatabase(name);
  try { await upgraded.open(); await restoreBackup(upgraded, copy, { mode: "merge" }); expect(await upgraded.reviews.count()).toBe(2); }
  finally { upgraded.close(); await upgraded.delete(); }
});
