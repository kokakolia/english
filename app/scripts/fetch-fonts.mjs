/**
 * Скачивает шрифты к себе.
 *
 * Приложение офлайновое, а `<link>` на Google Fonts без сети не работает: без
 * шрифтов страница отрисуется чем попало, и на разных устройствах по-разному.
 * Поэтому файлы лежат рядом с приложением и попадают в офлайн-кэш вместе с ним.
 *
 * Скачивается только то, что нужно: латиница и кириллица. Вьетнамский,
 * математические знаки и прочие подмножества Google Fonts отдаёт до кучи, а
 * весят они как основной текст.
 *
 * Запускается вручную: `node scripts/fetch-fonts.mjs`. Результат коммитится,
 * потому что сборка не должна зависеть от чужого сервера.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "assets", "fonts");

// Современный User-Agent обязателен: иначе Google Fonts отдаёт ttf вместо woff2.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FAMILIES = [
  { name: "Marcellus", query: "family=Marcellus" },
  { name: "Lora", query: "family=Lora:ital,wght@0,400;0,500;1,400" },
  {
    name: "CormorantGaramond",
    query: "family=Cormorant+Garamond:wght@400;500",
  },
];

const KEEP_SUBSETS = new Set([
  "latin",
  "latin-ext",
  "cyrillic",
  "cyrillic-ext",
]);

/** Разбирает ответ Google Fonts на отдельные правила @font-face. */
function parseFaces(css) {
  const faces = [];
  const blocks = css.split("/*").slice(1);
  for (const block of blocks) {
    const subset = block.slice(0, block.indexOf("*/")).trim();
    if (!KEEP_SUBSETS.has(subset)) continue;

    const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (url === undefined) continue;

    faces.push({
      subset,
      url,
      family: block.match(/font-family:\s*'([^']+)'/)?.[1] ?? "",
      style: block.match(/font-style:\s*(\w+)/)?.[1] ?? "normal",
      weight: block.match(/font-weight:\s*(\d+)/)?.[1] ?? "400",
      range: block.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim() ?? "",
    });
  }
  return faces;
}

await mkdir(outDir, { recursive: true });

const rules = [];
const filesByHash = new Map();
const downloads = new Map();
let downloaded = 0;

for (const family of FAMILIES) {
  const response = await fetch(
    `https://fonts.googleapis.com/css2?${family.query}&display=swap`,
    {
      headers: { "User-Agent": UA },
    },
  );
  if (!response.ok)
    throw new Error(`Font stylesheet failed: ${response.status}`);
  const css = await response.text();

  for (const face of parseFaces(css)) {
    let body = downloads.get(face.url);
    if (body === undefined) {
      const response = await fetch(face.url);
      if (!response.ok)
        throw new Error(`Font download failed: ${response.status}`);
      body = Buffer.from(await response.arrayBuffer());
      downloads.set(face.url, body);
    }
    const hash = createHash("sha256").update(body).digest("hex");
    let file = filesByHash.get(hash);
    if (file === undefined) {
      file = `${family.name}-${face.weight}${face.style === "italic" ? "i" : ""}-${face.subset}.woff2`;
      await writeFile(join(outDir, file), body);
      filesByHash.set(hash, file);
      downloaded += 1;
    }

    rules.push(
      `@font-face {\n` +
        `  font-family: '${face.family}';\n` +
        `  font-style: ${face.style};\n` +
        `  font-weight: ${face.weight};\n` +
        `  font-display: swap;\n` +
        `  src: url('./${file}') format('woff2');\n` +
        (face.range ? `  unicode-range: ${face.range};\n` : "") +
        `}`,
    );
  }
}

await writeFile(
  join(outDir, "fonts.css"),
  `/* Собрано скриптом scripts/fetch-fonts.mjs. Руками не правится. */\n\n` +
    rules.join("\n\n") +
    "\n",
  "utf-8",
);

console.log(`скачано файлов: ${downloaded}`);
console.log(`правил @font-face: ${rules.length}`);
console.log(`каталог: ${outDir}`);
