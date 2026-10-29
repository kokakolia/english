import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScheduler } from "../srs";
import { makeCard, makeDeck } from "../srs/testing";
import { createStudyController } from "../study/controller";
import { savedFolderName, saveBackupFile } from "../app/backup-file";
import { AppDatabase } from "./db";
import { importDeck, loadCards, type DeckFile } from "./decks";
import { exportBackup, restoreBackup, BackupFormatError } from "./backup";
import { buryCard, deckCounts, recordReview, resetCard, suspendCard, undoReview, unsuspendCard } from "./study";
import { updateStudySettings } from "./settings";
import { loadDeckFile, DeckLoadError, type FetchLike } from "./loader";

const NOW = new Date("2026-10-29T09:00:00Z");
const DAY = 86400000;
const scheduler = createScheduler({ enableFuzz: false });
let db: AppDatabase;
let counter = 0;
const cards = makeDeck(4);
const card = cards[0]!;
const card2 = cards[1]!;
function file(items = cards, version = "v1"): DeckFile {
  return { meta: { id: "audit", name: "Audit", version, language: "en", card_type: "cloze", built_at: new Date(NOW.getTime() + (version === "v1" ? 0 : 1)).toISOString(), count: items.length, chunks: ["cards-000.json"] }, cards: items };
}
async function review(grade: "easy" | "good" | "again" = "easy", now = NOW) {
  return recordReview(db, { cardId: card.id, deckId: "audit", grade, now, scheduler });
}
function controller(now = NOW) {
  return createStudyController({ db, deckId: "audit", clock: () => now, scheduler });
}
beforeEach(async () => {
  db = new AppDatabase(`regression-${counter++}`);
  await db.open();
  await importDeck(db, file());
});
afterEach(async () => { db.close(); await db.delete(); });

describe("восстановление учитывает действия, а не только последнее повторение", () => {
  it("старая копия не отменяет сброс, включая копию старого формата", async () => {
    await review();
    const backup = await exportBackup(db);
    backup.formatVersion = 1;
    delete backup.changes;
    await resetCard(db, card.id, NOW);
    await restoreBackup(db, backup, { mode: "merge" });
    expect(await db.progress.get(card.id)).toBeUndefined();
  });

  it("старая копия не возвращает отменённую оценку", async () => {
    const result = await review();
    const backup = await exportBackup(db);
    await undoReview(db, { cardId: card.id, reviewId: result.reviewId, previous: result.previous, now: NOW });
    await restoreBackup(db, backup, { mode: "merge" });
    expect(await db.progress.get(card.id)).toBeUndefined();
    expect((await db.reviews.get(result.reviewId))?.undone).toBe(true);
  });

  it("отмена повторения знакомой карточки сохраняет предыдущее расписание", async () => {
    await review();
    const result = await review("easy", new Date(NOW.getTime() + 10 * DAY));
    const backup = await exportBackup(db);
    await undoReview(db, { cardId: card.id, reviewId: result.reviewId, previous: result.previous, now: new Date(NOW.getTime() + 10 * DAY) });
    await restoreBackup(db, backup, { mode: "merge" });
    expect(await db.progress.get(card.id)).toEqual(result.previous);
  });

  it("сброс переносится копией на другую базу и обновляет старое выученное", async () => {
    await review();
    const old = await exportBackup(db);
    await resetCard(db, card.id, NOW);
    const reset = await exportBackup(db);
    await restoreBackup(db, old);
    await restoreBackup(db, reset, { mode: "merge" });
    expect(await db.progress.get(card.id)).toBeUndefined();
    expect(await db.changes.get(card.id)).toBeDefined();
  });

  it("приостановка после копии не теряется при слиянии", async () => {
    await review();
    const old = await exportBackup(db);
    await suspendCard(db, { cardId: card.id, deckId: "audit", now: NOW });
    await restoreBackup(db, old, { mode: "merge" });
    expect((await db.progress.get(card.id))?.suspended).toBe(true);
  });

  it("принимает свежую отмену журнала из другой копии", async () => {
    const result = await review();
    const old = await exportBackup(db);
    await undoReview(db, { cardId: card.id, reviewId: result.reviewId, previous: result.previous, now: NOW });
    const fresh = await exportBackup(db);
    await restoreBackup(db, old);
    await restoreBackup(db, fresh, { mode: "merge" });
    expect((await db.reviews.toArray())[0]?.undone).toBe(true);
  });

  it("облегчённая копия не мешает загрузить карточки той же версии", async () => {
    const backup = await exportBackup(db, { includeCards: false });
    await restoreBackup(db, backup);
    expect(await db.cards.count()).toBe(0);
    expect((await importDeck(db, file())).added).toBe(4);
    expect(await db.cards.count()).toBe(4);
  });

  it("старая копия не откатывает новую версию контента", async () => {
    const old = await exportBackup(db);
    const newer = file(cards.map(c => ({ ...c, translation: "новый перевод" })), "v2");
    newer.meta.built_at = new Date(NOW.getTime() + DAY).toISOString();
    await importDeck(db, newer);
    await restoreBackup(db, old, { mode: "merge" });
    expect((await db.decks.get("audit"))?.version).toBe("v2");
    expect((await db.cards.get(card.id))?.translation).toBe("новый перевод");
  });
});

describe("счётчики и фактическая очередь согласованы", () => {
  it("оставшийся прогресс удалённой карточки не блокирует новые", async () => {
    await review();
    await importDeck(db, file([card2], "v2"));
    expect(await deckCounts(db, "audit", NOW)).toMatchObject({ total: 1, fresh: 1, due: 0 });
    expect((await controller()).state().counts.fresh).toBe(1);
  });

  it("приостановленные и закопанные повторы не показываются доступными", async () => {
    await importDeck(db, file([card], "v2"));
    await review();
    const later = new Date(NOW.getTime() + 100 * DAY);
    await suspendCard(db, { cardId: card.id, deckId: "audit", now: later });
    expect((await deckCounts(db, "audit", later)).due).toBe(0);
    await unsuspendCard(db, { cardId: card.id, deckId: "audit", now: later });
    await buryCard(db, { cardId: card.id, deckId: "audit", now: later });
    expect((await deckCounts(db, "audit", later)).due).toBe(0);
  });

  it("закопанная новая карточка снова доступна на следующий день", async () => {
    await importDeck(db, file([card], "v2"));
    await buryCard(db, { cardId: card.id, deckId: "audit", now: NOW });
    expect((await deckCounts(db, "audit", NOW)).fresh).toBe(0);
    expect((await deckCounts(db, "audit", new Date(NOW.getTime() + DAY))).fresh).toBe(1);
  });

  it("второе занятие не выдаёт ещё одну порцию дневного лимита", async () => {
    await updateStudySettings(db, { newPerDay: 2 });
    const first = await controller();
    for (let i = 0; i < 2; i++) { first.reveal(); await first.grade("easy"); }
    expect(first.state().phase).toBe("finished");
    expect((await controller()).state().counts.fresh).toBe(0);
    expect((await deckCounts(db, "audit", NOW, 120, 2)).fresh).toBe(0);
    expect((await controller(new Date(NOW.getTime() + DAY))).state().counts.fresh).toBe(2);
  });

  it("дневной лимит повторов учитывает предыдущее занятие", async () => {
    const old = new Date(NOW.getTime() - 100 * DAY);
    for (const c of cards) await recordReview(db, { cardId: c.id, deckId: "audit", grade: "easy", now: old, scheduler });
    await updateStudySettings(db, { newPerDay: 0, reviewsPerDay: 1 });
    const first = await controller(); first.reveal(); await first.grade("easy");
    expect((await controller()).state().counts.review).toBe(0);
    expect((await deckCounts(db, "audit", NOW, 1, 0)).backlog).toBe(3);
  });

  it("отменённый ответ не расходует дневной лимит новых", async () => {
    await updateStudySettings(db, { newPerDay: 1 });
    const first = await controller(); first.reveal(); await first.grade("easy"); await first.undo();
    expect((await controller()).state().counts.fresh).toBe(1);
  });
});

describe("содержимое JSON проверяется до изменения базы", () => {
  it.each(["due", "state", "stability", "reps", "lastReview"])("повреждённое поле прогресса %s отклоняется", async key => {
    await review(); const backup = await exportBackup(db);
    const row = backup.progress[0] as unknown as Record<string, unknown>; row[key] = "invalid";
    await expect(restoreBackup(db, backup)).rejects.toBeInstanceOf(BackupFormatError);
    expect((await db.progress.get(card.id))?.reps).toBe(1);
  });

  it("повторяющиеся ID в копии отклоняются", async () => {
    const backup = await exportBackup(db); backup.cards.push(backup.cards[0]!);
    await expect(restoreBackup(db, backup)).rejects.toBeInstanceOf(BackupFormatError);
  });

  it("обрезанная колода и ссылки на неизвестную колоду отклоняются", async () => {
    const backup = await exportBackup(db); backup.cards.pop();
    await expect(restoreBackup(db, backup)).rejects.toBeInstanceOf(BackupFormatError);
    const other = await exportBackup(db); other.cards[0]!.deckId = "unknown";
    await expect(restoreBackup(db, other)).rejects.toBeInstanceOf(BackupFormatError);
    expect(await db.cards.count()).toBe(4);
  });

  it("повреждённые карточки с двумя пропусками не импортируются", async () => {
    const invalid = file([makeCard({ text: "___ and ___" })], "bad");
    await expect(importDeck(db, invalid)).rejects.toThrow();
    expect(await db.cards.count()).toBe(4);
  });

  it("не принимает неправильные карточки из сети при верном их количестве", async () => {
    const fetcher: FetchLike = async url => ({ ok: true, status: 200, json: async () => url.endsWith("deck.json") ? file().meta : cards.map(c => ({ ...c, also: undefined })) });
    await expect(loadDeckFile("/audit", fetcher)).rejects.toBeInstanceOf(DeckLoadError);
  });

  it("отклоняет отрицательные лимиты и неподходящую retention", async () => {
    await expect(updateStudySettings(db, { newPerDay: -1 })).rejects.toThrow();
    await expect(updateStudySettings(db, { requestRetention: 1 })).rejects.toThrow();
  });
});

describe("настройки устройства не переносят разрешение на папку", () => {
  it("экспорт исключает папку, а импорт старого формата сохраняет локальную", async () => {
    await db.settings.put({ key: "backupFolder", value: { name: "local" } });
    const backup = await exportBackup(db);
    expect(backup.settings.some(row => row.key === "backupFolder")).toBe(false);
    backup.settings.push({ key: "backupFolder", value: {} });
    await restoreBackup(db, JSON.parse(JSON.stringify(backup)), { mode: "merge" });
    expect((await db.settings.get("backupFolder"))?.value).toEqual({ name: "local" });
  });

  it("повреждённый сохранённый handle удаляется и можно выбрать папку заново", async () => {
    await db.settings.put({ key: "backupFolder", value: {} });
    expect(await savedFolderName(db)).toBeNull();
    expect((await db.settings.get("backupFolder"))?.value).toBeNull();
    const target = globalThis as unknown as { window: unknown }; const original = target.window;
    target.window = { showDirectoryPicker: async () => { throw new DOMException("cancel", "AbortError"); } };
    try { expect((await saveBackupFile(db, "copy.gz", new Blob())).kind).toBe("cancelled"); }
    finally { target.window = original; }
  });
});

it("requestRetention из настроек реально меняет расписание контроллера", async () => {
  await updateStudySettings(db, { requestRetention: 0.7, newPerDay: 1 });
  const relaxed = await createStudyController({ db, deckId: "audit", clock: () => NOW });
  const id = relaxed.state().card!.id;
  relaxed.reveal(); await relaxed.grade("easy");
  const firstDue = (await db.progress.get(id))!.due;
  await resetCard(db, id, NOW);
  await db.reviews.clear();
  await updateStudySettings(db, { requestRetention: 0.99 });
  const strict = await createStudyController({ db, deckId: "audit", clock: () => NOW });
  strict.reveal(); await strict.grade("easy");
  expect(Date.parse((await db.progress.get(id))!.due)).toBeLessThan(Date.parse(firstDue));
});

it("журнал хранит фактический интервал текущего повторения", async () => {
  await review(); await review("good", new Date(NOW.getTime() + 10 * DAY));
  expect((await db.reviews.toArray())[1]?.elapsedDays).toBe(10);
});

it("обновляет метаданные карточки, даже если текст и перевод не менялись", async () => {
  const next = file(cards.map(c => ({ ...c, band: "rare", cefr: "B2", headword: "changed" })), "v2");
  expect((await importDeck(db, next)).updated).toBe(4);
  expect((await loadCards(db, "audit"))[0]?.headword).toBe("changed");
});

it("миграция с первой версии базы сохраняет прогресс и журнал", async () => {
  const name = `legacy-${counter++}`;
  const legacy = new Dexie(name);
  legacy.version(1).stores({ decks: "id, importedAt", cards: "id, deckId, position, headword, relation, band, cefr",
    progress: "cardId, deckId, due, state, [deckId+due]", reviews: "++id, cardId, reviewedAt, [cardId+reviewedAt]", settings: "key" });
  await legacy.open();
  const row = { ...scheduler.create(card.id, NOW), deckId: "audit" };
  await legacy.table("progress").put(row);
  legacy.close();
  const upgraded = new AppDatabase(name);
  try {
    await upgraded.open();
    expect(await upgraded.progress.get(card.id)).toEqual(row);
    expect(await upgraded.changes.count()).toBe(0);
    await upgraded.changes.put({ cardId: card.id, deckId: "audit", changedAt: NOW.toISOString() });
  } finally { upgraded.close(); await upgraded.delete(); }
});
