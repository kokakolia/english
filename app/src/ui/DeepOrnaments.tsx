/**
 * Орнаменты тёмной темы: морское дно.
 *
 * Из макета `design/dark-*.html`. Там композиция нарисована под холст
 * 1440×900, который масштабируется скриптом целиком; здесь она собрана
 * растягивающейся — водоросли держатся нижних углов, светящийся пучок висит
 * у правого края, планктон рассыпан по полю.
 *
 * Свечение сделано размытием, а не полупрозрачными кругами: на чёрном фоне
 * круг с прозрачностью даёт видимый край, и вместо огонька получается блин.
 */

export function DeepDefs() {
  return (
    <svg className="ornament-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="deep-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="0.7" />
        </filter>
        <filter id="deep-tip" x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <radialGradient id="deep-vignette" cx="50%" cy="22%" r="75%">
          <stop offset="0%" stopColor="#0a1220" />
          <stop offset="55%" stopColor="#020308" />
          <stop offset="100%" stopColor="#000000" />
        </radialGradient>

        <symbol id="kelp" viewBox="0 0 140 220">
          <path
            d="M20 214 C 30 170 15 130 35 90 C 50 60 25 30 45 0"
            fill="none"
            stroke="var(--ornament-stem)"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <g fill="var(--ornament-stem)">
            <path d="M20 214 C 8 204 4 190 8 178 C 20 184 24 200 20 214 Z" />
            <path d="M27 188 C 40 180 46 168 44 156 C 30 160 24 174 27 188 Z" />
            <path d="M18 162 C 4 156 -2 144 0 132 C 14 136 20 150 18 162 Z" />
            <path d="M32 138 C 46 132 52 120 50 108 C 36 111 30 126 32 138 Z" />
            <path d="M22 112 C 8 107 1 95 3 84 C 17 87 24 100 22 112 Z" />
            <path d="M36 86 C 49 80 54 69 52 58 C 39 61 33 74 36 86 Z" />
            <path d="M28 60 C 15 56 8 45 10 34 C 23 37 30 49 28 60 Z" />
            <path d="M40 34 C 52 28 56 18 54 8 C 42 11 37 23 40 34 Z" />
          </g>
        </symbol>

        <symbol id="plankton" viewBox="-8 -8 16 16">
          <circle r="3.2" fill="#bfe6ff" />
        </symbol>
      </defs>
    </svg>
  );
}

/** Толща воды: свет сверху, чернота по краям. */
export function DeepBackground() {
  return (
    <svg
      className="ornament-bg"
      viewBox="0 0 1440 900"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="1440" height="900" fill="url(#deep-vignette)" />
    </svg>
  );
}

/**
 * Водоросли в нижнем углу. Правый экземпляр отражён через CSS.
 *
 * `viewBox` обязателен и подобран по содержимому. Без него svg считает свои
 * координаты пикселями бокса: куст 149×306 рисовался в боксе 205×240 —
 * низ обрезало, а сам куст сидел не там, где нужно.
 *
 * `width`/`height` у `<use>` равны размерам `viewBox` символа. Любые другие
 * включают подгонку внутри `<use>`, и символ повисает по центру отведённого
 * места вместо того, чтобы стоять, где поставили.
 */
export function KelpCorner({ side }: { side: "left" | "right" }) {
  return (
    <svg
      className={`ornament-kelp ornament-kelp--${side}`}
      viewBox="-4 0 122 232"
      preserveAspectRatio="xMinYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      {/* Без размытия. Оно задано в единицах viewBox, а у водорослей масштаб
          в полтора раза крупнее, чем у пучка справа: одно и то же
          `stdDeviation` давало им вдвое более толстую размывку, и рядом с
          чётким пучком они выглядели не мягкими, а расфокусированными. */}
      <g>
        <use href="#kelp" x="0" y="12" width="140" height="220" />
        <g transform="translate(74,36) scale(0.72)" opacity="0.75">
          <use href="#kelp" x="0" y="0" width="140" height="220" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Светящийся пучок у правого края — то же место, что вьюнок в светлой теме.
 * Только на широком экране: на телефоне он налезал бы на карточку.
 */
export function GlowTendrils() {
  // Огоньки стоят ровно на концах нитей: координаты списаны с последних точек
  // путей. Раньше они сдвигались общим `translate`, и совпадение держалось на
  // честном слове — стоило подправить путь, и огонёк повисал в стороне.
  const tips: [number, number, number][] = [
    [1350, 350, 4],
    [1380, 370, 4.5],
    [1400, 390, 4],
    [1418, 370, 3.8],
    [1430, 348, 4.2],
  ];
  return (
    <svg
      className="ornament-tendrils"
      // Кадр начинается ровно от точки, из которой растут нити (1400, 20):
      // тогда `top: 0` притягивает пучок к верхнему краю, и он висит на нём,
      // а не парит в воздухе. Раньше кадр начинался выше, и между краем окна
      // и креплением оставался зазор.
      viewBox="1340 20 104 384"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <g
        filter="url(#deep-soft)"
        stroke="var(--ornament-accent)"
        strokeWidth="2.4"
        fill="none"
        opacity="0.8"
      >
        <path d="M1400 20 C 1370 100 1400 160 1360 230 C 1330 290 1360 320 1350 350" />
        <path d="M1400 20 C 1390 110 1360 170 1385 240 C 1400 290 1370 320 1380 370" />
        <path d="M1400 20 C 1400 110 1420 170 1400 240 C 1385 290 1410 320 1400 390" />
        <path d="M1400 20 C 1410 110 1438 170 1416 240 C 1404 290 1428 320 1418 370" />
        <path d="M1400 20 C 1418 100 1400 160 1428 228 C 1446 286 1414 318 1430 348" />
      </g>
      <g filter="url(#deep-tip)" fill="#bfe6ff">
        {tips.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <g fill="#e7f3fc">
        {tips.map(([cx, cy]) => (
          <circle key={`core-${cx}-${cy}`} cx={cx} cy={cy} r={1.6} />
        ))}
      </g>
    </svg>
  );
}

/** Планктон: редкие светлячки по полю. */
export function Plankton() {
  const dots: [string, string, number][] = [
    ["3%", "26%", 13],
    ["96%", "20%", 11],
    ["5%", "52%", 15],
    ["97%", "70%", 12],
    ["8%", "78%", 9],
  ];
  return (
    <>
      {dots.map(([left, top, size]) => (
        <svg
          key={`${left}-${top}`}
          className="ornament-plankton"
          style={{ left, top, width: size, height: size }}
          viewBox="-8 -8 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <use
            href="#plankton"
            x="-8"
            y="-8"
            width="16"
            height="16"
            filter="url(#deep-soft)"
          />
        </svg>
      ))}
    </>
  );
}
