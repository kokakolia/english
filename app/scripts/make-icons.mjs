/**
 * Рисует иконки приложения.
 *
 * Без иконок Chrome не считает приложение устанавливаемым и не показывает
 * значок установки — при этом ничего не сообщает, просто молчит. Нужен хотя бы
 * один PNG не меньше 144 пикселей; на практике кладут 192 и 512.
 *
 * Рисуется здесь, а не в графическом редакторе, по той же причине, по которой
 * шрифты лежат в репозитории: результат должен быть пересобираемым. Правится
 * палитра — иконки перерисовываются одной командой, и никто не ищет исходник
 * в чужой программе.
 *
 * Зависимостей нет: PNG собирается руками, сжатие берётся из встроенного zlib.
 * Тянуть ради трёх картинок графическую библиотеку с полусотней транзитивных
 * пакетов — плохой размен.
 *
 * Запускается вручную: `node scripts/make-icons.mjs`. Результат коммитится.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Палитра из styles.css. При изменении там — поменять и здесь.
const PAPER = [0xf3, 0xee, 0xdc];
const GOLD = [0xb8, 0x89, 0x2b];
const GOLD_DEEP = [0x96, 0x72, 0x1c];
const INK = [0x1f, 0x3a, 0x2e];

/** Таблица CRC32 — по спецификации PNG. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Собирает PNG из массива RGBA размером size×size. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // бит на канал
  header[9] = 6; // RGBA
  // Каждой строке предшествует байт фильтра. Ноль — «без фильтра»: картинка
  // маленькая, и выигрыш от подбора фильтров не стоит усложнения.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Лист — та же фигура, что в орнаментах приложения: пересечение двух кругов.
 *
 * Не нужен растеризатор кривых: точка внутри листа, если лежит внутри обоих
 * кругов. Круги стоят симметрично слева и справа, и линза между ними и есть
 * лист.
 *
 * Задаются нужные полуширина и полувысота, радиус и разнос кругов считаются
 * из них. Обратный порядок — задать радиус и разнос — обманчив: на глаз не
 * видно, какой получится фигура, и лист выходит вчетверо у́же задуманного.
 *
 * Вывод: круги радиуса r в точках (±d, 0) пересекаются по линзе шириной
 * 2(r − d) и высотой 2√(r² − d²). Отсюда r − d = w и (r − d)(r + d) = h²,
 * значит r + d = h²/w.
 */
function makeLeafShape(halfWidth, halfHeight) {
  const radius = (halfWidth + (halfHeight * halfHeight) / halfWidth) / 2;
  const offset = radius - halfWidth;
  return (x, y) =>
    Math.hypot(x + offset, y) <= radius && Math.hypot(x - offset, y) <= radius;
}

/**
 * Рисует иконку.
 *
 * `padding` — доля поля вокруг рисунка. Для maskable-иконки она больше:
 * система вправе обрезать её до круга, и всё существенное должно уместиться
 * в центральных 80% — иначе Android срежет кончики листа.
 */
function drawIcon(size, { padding = 0.16, background = PAPER } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const inner = size * (1 - padding * 2);

  const insideLeaf = makeLeafShape(inner * 0.155, inner * 0.375);

  const ringOuter = inner * 0.5;
  const ringInner = ringOuter - Math.max(2, size * 0.022);
  const veinHalf = Math.max(0.5, size * 0.007);

  // Сглаживание выборкой: каждый пиксель считается по сетке 4×4 внутри себя,
  // и цвет получается смешением. Дёшево и убирает лестницу на краях.
  const SUB = 4;
  const step = 1 / SUB;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;

      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const x = px + (sx + 0.5) * step - center;
          const y = py + (sy + 0.5) * step - center;
          const distance = Math.hypot(x, y);

          let colour = background;
          if (distance <= ringOuter && distance >= ringInner) {
            colour = GOLD;
          } else if (insideLeaf(x, y)) {
            // Прожилка по середине листа — тем же тёмным, что и текст.
            colour = Math.abs(x) <= veinHalf ? INK : GOLD;
          } else if (distance < ringInner) {
            colour = background;
          }

          rSum += colour[0];
          gSum += colour[1];
          bSum += colour[2];
        }
      }

      const samples = SUB * SUB;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(rSum / samples);
      rgba[at + 1] = Math.round(gSum / samples);
      rgba[at + 2] = Math.round(bSum / samples);
      rgba[at + 3] = 255;
    }
  }

  return encodePng(size, rgba);
}

const files = [
  ["icon-192.png", drawIcon(192)],
  ["icon-512.png", drawIcon(512)],
  // Maskable: поле шире, потому что система обрежет иконку до своей формы.
  ["icon-maskable-512.png", drawIcon(512, { padding: 0.26 })],
  ["apple-touch-icon.png", drawIcon(180, { padding: 0.12 })],
];

for (const [name, data] of files) {
  writeFileSync(join(outDir, name), data);
  console.log(`${name}: ${(data.length / 1024).toFixed(1)} КБ`);
}

// Фавиконка отдельно: вектор, чтобы не мылилась на вкладке.
const leafPath =
  "M32 56 C 14 46 14 18 32 8 C 50 18 50 46 32 56 Z";
writeFileSync(
  join(outDir, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n` +
    `  <rect width="64" height="64" rx="12" fill="#f3eedc"/>\n` +
    `  <circle cx="32" cy="32" r="27" fill="none" stroke="#b8892b" stroke-width="2"/>\n` +
    `  <path d="${leafPath}" fill="#b8892b"/>\n` +
    `  <line x1="32" y1="9" x2="32" y2="55" stroke="#1f3a2e" stroke-width="1.6"/>\n` +
    `</svg>\n`,
  "utf-8",
);
console.log("favicon.svg");
console.log(`каталог: ${outDir}`);

// Тёмное золото в палитре есть, но в рисунке не пригодилось — оставлено,
// чтобы правка палитры не требовала вспоминать, откуда брались цвета.
void GOLD_DEEP;
