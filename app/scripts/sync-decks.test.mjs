import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { syncDecks } from "./sync-decks.mjs";

test("каталог исходников не может быть очищен как назначение", async (t) => {
  const { source } = await fixture(t);
  await assert.rejects(syncDecks(source, source), /separate directories/);
  await assert.rejects(
    syncDecks(source, join(source, "public")),
    /separate directories/,
  );
  assert.ok(await readFile(join(source, "index.json"), "utf8"));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deck-packaging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    target = join(root, "public");
  await mkdir(join(source, "demo"), { recursive: true });
  await mkdir(target);
  const json = (path, data) => writeFile(path, JSON.stringify(data));
  await json(join(source, "index.json"), {
    decks: [{ id: "demo", path: "demo/deck.json" }],
  });
  await json(join(source, "demo", "deck.json"), {
    id: "demo",
    count: 1,
    chunks: ["cards-000-1234567890abcdef.json"],
  });
  await json(join(source, "demo", "cards-000-1234567890abcdef.json"), [
    { id: "card" },
  ]);
  await writeFile(join(target, "previous.txt"), "previous build");
  return { source, target, json };
}

test("публикуются только части из манифеста; старые исходные части сохраняются", async (t) => {
  const { source, target } = await fixture(t);
  await writeFile(join(source, "demo", "cards-000.json"), "legacy part");
  assert.equal(await syncDecks(source, target), 3);
  assert.deepEqual((await readdir(join(target, "demo"))).sort(), [
    "cards-000-1234567890abcdef.json",
    "deck.json",
  ]);
  assert.equal(
    await readFile(join(source, "demo", "cards-000.json"), "utf8"),
    "legacy part",
  );
  assert.deepEqual((await readdir(target)).sort(), ["demo", "index.json"]);
});

test("отсутствующая часть оставляет предыдущую public-копию", async (t) => {
  const { source, target } = await fixture(t);
  await rm(join(source, "demo", "cards-000-1234567890abcdef.json"));
  await assert.rejects(syncDecks(source, target));
  assert.equal(
    await readFile(join(target, "previous.txt"), "utf8"),
    "previous build",
  );
});

test("пути вне каталога не читаются и не очищают public", async (t) => {
  const { source, target, json } = await fixture(t);
  await json(join(source, "index.json"), {
    decks: [{ id: "../outside", path: "../outside/deck.json" }],
  });
  await assert.rejects(syncDecks(source, target), /Invalid deck path/);
  assert.equal(
    await readFile(join(target, "previous.txt"), "utf8"),
    "previous build",
  );
});

test("несовпадение количества карточек отменяет копирование", async (t) => {
  const { source, target, json } = await fixture(t);
  await json(join(source, "demo", "cards-000-1234567890abcdef.json"), []);
  await assert.rejects(syncDecks(source, target), /Incomplete deck/);
  assert.equal(
    await readFile(join(target, "previous.txt"), "utf8"),
    "previous build",
  );
});
