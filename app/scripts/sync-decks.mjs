/** Копирует в public только опубликованные манифесты и указанные в них части. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function syncDecks(source, target) {
  source = resolve(source);
  target = resolve(target);
  function contains(parent, child) {
    const path = relative(parent, child);
    return (
      path === "" ||
      (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path))
    );
  }
  if (
    dirname(target) === target ||
    contains(target, source) ||
    contains(source, target)
  ) {
    throw new Error("Deck source and destination must be separate directories");
  }
  const files = new Map();
  async function read(name) {
    const body = await readFile(join(source, name));
    files.set(name, body);
    return JSON.parse(body.toString("utf8"));
  }
  const index = await read("index.json");
  if (!Array.isArray(index?.decks) || index.decks.length === 0)
    throw new Error("Invalid deck index");
  const ids = new Set();
  for (const entry of index.decks) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9-]+$/.test(entry.id) ||
      entry.path !== `${entry.id}/deck.json` ||
      ids.has(entry.id)
    )
      throw new Error("Invalid deck path");
    ids.add(entry.id);
    const meta = await read(entry.path);
    if (
      meta?.id !== entry.id ||
      !Number.isInteger(meta.count) ||
      meta.count < 0 ||
      !Array.isArray(meta.chunks) ||
      !meta.chunks.every(
        (name) =>
          typeof name === "string" &&
          /^cards-\d{3}(-[0-9a-f]{16})?\.json$/.test(name),
      ) ||
      new Set(meta.chunks).size !== meta.chunks.length
    )
      throw new Error(`Invalid deck manifest: ${entry.id}`);
    const cards = [];
    for (const chunk of meta.chunks) {
      const part = await read(`${entry.id}/${chunk}`);
      if (!Array.isArray(part)) throw new Error(`Invalid deck chunk: ${chunk}`);
      cards.push(...part);
    }
    if (
      cards.length !== meta.count ||
      cards.some((card) => typeof card?.id !== "string") ||
      new Set(cards.map((card) => card.id)).size !== cards.length
    )
      throw new Error(`Incomplete deck: ${entry.id}`);
  }
  // Читаем весь снимок до очистки public: ошибка исходников сохраняет старую копию.
  await rm(target, { recursive: true, force: true });
  for (const [name, body] of files) {
    const destination = join(target, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, body);
  }
  return files.size;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const count = await syncDecks(
    join(appRoot, "..", "decks"),
    join(appRoot, "public", "decks"),
  );
  console.log(`Published ${count} deck files to public/decks`);
}
