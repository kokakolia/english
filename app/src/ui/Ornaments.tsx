/**
 * Орнаменты из макета.
 *
 * В макете фон нарисован под жёстко заданный размер холста — 1440×900 на ПК и
 * 390×844 на телефоне. Приложение так жить не может: окно бывает любым.
 * Поэтому та же композиция собрана на растягивающемся SVG: папоротники держатся
 * углов, вьюнок — правого края, зерно кроет всё поле.
 */

import { useDark } from "./ThemeContext";

export function OrnamentDefs() {
  return (
    <svg className="ornament-defs" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="fern" viewBox="0 0 140 200">
          <path
            d="M10 190 C 20 140 15 90 40 40 C 55 15 70 5 90 0"
            fill="none"
            stroke="var(--ornament-stem)"
            strokeWidth="2.5"
          />
          <g fill="var(--ornament-stem)">
            <ellipse cx="25" cy="170" rx="14" ry="5" transform="rotate(-35 25 170)" />
            <ellipse cx="15" cy="150" rx="12" ry="4.5" transform="rotate(35 15 150)" />
            <ellipse cx="22" cy="130" rx="13" ry="5" transform="rotate(-30 22 130)" />
            <ellipse cx="18" cy="108" rx="11" ry="4" transform="rotate(30 18 108)" />
            <ellipse cx="28" cy="88" rx="12" ry="4.5" transform="rotate(-28 28 88)" />
            <ellipse cx="30" cy="66" rx="10" ry="4" transform="rotate(25 30 66)" />
            <ellipse cx="45" cy="48" rx="10" ry="4" transform="rotate(-25 45 48)" />
            <ellipse cx="55" cy="30" rx="8" ry="3.5" transform="rotate(20 55 30)" />
            <ellipse cx="70" cy="16" rx="7" ry="3" transform="rotate(-15 70 16)" />
          </g>
          <circle cx="90" cy="2" r="3" fill="var(--ornament-accent)" />
        </symbol>

        <symbol id="flower" viewBox="-10 -10 20 20">
          <g fill="currentColor">
            <circle cx="0" cy="-6" r="3" />
            <circle cx="5.6" cy="-1.8" r="3" />
            <circle cx="3.5" cy="4.8" r="3" />
            <circle cx="-3.5" cy="4.8" r="3" />
            <circle cx="-5.6" cy="-1.8" r="3" />
          </g>
          {/* Сердцевина цветка — своя переменная, а не цвет стебля. При
              переводе на переменные я свёл её к стеблю, и в светлой теме
              тёмное золото стало тёмно-зелёным. */}
          <circle r="1.8" fill="var(--ornament-core)" />
        </symbol>

        <filter id="grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
            result="noise"
          />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="0 0 0 0 0.12  0 0 0 0 0.23  0 0 0 0 0.18  0 0 0 0.06 0"
          />
        </filter>
      </defs>
    </svg>
  );
}

/** Фон страницы: зерно, папоротники по углам и вьюнок справа. */
export function Background() {
  return (
    <svg
      className="ornament-bg"
      viewBox="0 0 1440 900"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="1440" height="900" filter="url(#grain)" />
    </svg>
  );
}

/**
 * Папоротник в углу. Повёрнутый экземпляр ставится через CSS.
 *
 * `viewBox` обязателен: без него svg считает свои координаты пикселями бокса,
 * и содержимое 230×328 единиц обрезалось краем на любом окне у́же 1438
 * пикселей. В макете этого нет — там всё лежит в одном холсте 1440×900.
 */
export function CornerFern({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg
      className={`ornament-fern ornament-fern--${corner}`}
      viewBox="0 0 230 328"
      aria-hidden="true"
      focusable="false"
    >
      <use href="#fern" width="230" height="328" />
    </svg>
  );
}

/**
 * Вьюнок с цветами вдоль правого края — только на широком экране.
 *
 * Масштаб равномерный. С `preserveAspectRatio="none"` кадр 80×760 растягивался
 * в бокс высотой во весь экран: на высоком окне волна вытягивалась и шла
 * прямой, на низком — сжималась и выгибалась дугой. Форма вьюнка не должна
 * зависеть от размера окна.
 */
export function SideVine() {
  return (
    <svg
      className="ornament-vine"
      viewBox="1360 100 80 760"
      aria-hidden="true"
      focusable="false"
    >
      {/* Вьюнок идёт вдоль края, а не поперёк кадра.
        *
        * Кривизна задаётся не размахом, а его отношением к длине волны. В
        * прежнем пути было 34 единицы размаха на полуволну в 233 — 0,14, и
        * читался он чередой дуг. Уменьшать один размах бесполезно: короткая
        * волна остаётся крутой при любом размахе.
        *
        * Здесь одна волна на всю высоту: полуволна 380 при размахе 26, то есть
        * 0,068 — вдвое положе. Лоза идёт вдоль края, правая вершина уходит за
        * него на пять единиц и возвращается, левая отходит от края на двадцать
        * и остаётся видна.
        *
        * Вершины волны — узловые точки, управляющие стоят строго над и под
        * ними: касательная в вершине вертикальна, и волна не заваливается. */}
      <g fill="none" stroke="var(--ornament-accent)" strokeWidth="1.5" opacity="0.4">
        <path
          d="M 1432 100
             C 1432 195 1419 195 1419 290
             C 1419 480 1445 480 1445 670
             C 1445 765 1432 765 1432 860"
        />
      </g>
      <g color="var(--ornament-accent)" opacity="0.65">
        {/* Цветки висят слева от лозы — там, где она дальше всего от края. */}
        <use href="#flower" x="1409" y="132" width="16" height="16" />
        <use href="#flower" x="1399" y="281" width="18" height="18" />
        <use href="#flower" x="1404" y="790" width="20" height="20" />
      </g>
    </svg>
  );
}

/** Завиток в углу панели. */
export function PanelFlourish({ position }: { position: "start" | "end" }) {
  return (
    <svg
      className={`flourish flourish--${position}`}
      viewBox="0 0 26 26"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 24 C2 10 10 2 24 2" fill="none" stroke="var(--ornament-accent)" strokeWidth="1.2" />
      <path d="M2 24 C2 16 6 12 12 12" fill="none" stroke="var(--ornament-accent)" strokeWidth="1" />
      <circle cx="24" cy="2" r="1.6" fill="var(--ornament-accent)" />
    </svg>
  );
}

/**
 * Метка-разделитель у заголовка и счётчика.
 *
 * В светлой теме это лист с прожилкой. В тёмной — пузырёк.
 *
 * Лист в тёмной теме не годился: прожилка превращала узкую фигуру в зерно.
 * Контурный эллипс из макета оказался не лучше — высокий и узкий, он на
 * двенадцати пикселях распадался на две скобки: верхняя и нижняя дуги у него
 * почти плоские и истончаются до невидимости, а боковые остаются.
 *
 * У круга кривизна одинаковая по всему контуру, поэтому он не разваливается
 * ни в каком размере. Блик сверху слева отличает пузырь от просто кружка.
 */
export function Leaf({ className = "" }: { className?: string }) {
  if (useDark()) {
    return (
      <svg
        className={`${className} counter-bubble`}
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx="8"
          cy="8"
          r="5.8"
          fill="none"
          stroke="var(--ornament-accent)"
          strokeWidth="1.1"
        />
        <path
          d="M4.9 6.5 A 3.9 3.9 0 0 1 6.9 4.5"
          fill="none"
          stroke="var(--ornament-accent)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 12 16" aria-hidden="true" focusable="false">
      <path
        d="M6 15 C1 12 1 4 6 1 C11 4 11 12 6 15 Z"
        fill="none"
        stroke="var(--ornament-accent)"
        strokeWidth="1"
      />
      <line x1="6" y1="2" x2="6" y2="14" stroke="var(--ornament-accent)" strokeWidth="0.8" />
    </svg>
  );
}

/** Стрелка отмены: дуга против часовой стрелки. */
export function UndoArrow() {
  return (
    <svg className="undo-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        d="M4 8 A 5.5 5.5 0 1 1 5.6 12.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M1.5 4.5 L4 8.4 L7.8 6.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Три точки: меню действий над карточкой. */
export function DotsIcon() {
  return (
    <svg className="dots-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle cx="9" cy="3.5" r="1.6" fill="currentColor" />
      <circle cx="9" cy="9" r="1.6" fill="currentColor" />
      <circle cx="9" cy="14.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

type Grade = "again" | "hard" | "good" | "easy";

/**
 * Значки на кнопках оценки.
 *
 * В светлой теме — росток от увядшего к цветущему, в тёмной — огонёк от
 * погасшего к яркому. Фигуры разные не ради разнообразия: росток на морском
 * дне не читается, а огонёк в саду ничего не значит.
 */
export function GradeIcon({ grade }: { grade: Grade }) {
  return useDark() ? <DeepGradeIcon grade={grade} /> : <GardenGradeIcon grade={grade} />;
}

/**
 * Морской набор: огонёк от погасшего к яркому.
 *
 * Всё построено на концентрических кругах и различается толщиной и свечением.
 * Первая версия рисовала расходящиеся нити, как у большой картинки на итогах,
 * — при двадцати четырёх пикселях они превращались в кашу и читались как рожки.
 * Круг остаётся кругом в любом размере.
 */
function DeepGradeIcon({ grade }: { grade: Grade }) {
  if (grade === "again") {
    return (
      <svg className="grade-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
        <circle
          cx="11"
          cy="11"
          r="7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeDasharray="2 3.5"
          opacity="0.8"
        />
      </svg>
    );
  }
  if (grade === "hard") {
    return (
      <svg className="grade-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.65" />
        <circle cx="11" cy="11" r="2.6" fill="currentColor" opacity="0.55" />
      </svg>
    );
  }
  if (grade === "good") {
    return (
      <svg className="grade-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="8.5" fill="currentColor" opacity="0.16" />
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="11" cy="11" r="3.6" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="grade-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="10" fill="currentColor" opacity="0.18" />
      <circle cx="11" cy="11" r="7.2" fill="currentColor" opacity="0.4" />
      <circle cx="11" cy="11" r="4.6" fill="currentColor" />
      {/* Искры по сторонам: единственное, что отличает «отлично» от «помню»
          силуэтом, а не одной лишь яркостью. */}
      <g fill="currentColor">
        <circle cx="11" cy="1.4" r="1.1" />
        <circle cx="11" cy="20.6" r="1.1" />
        <circle cx="1.4" cy="11" r="1.1" />
        <circle cx="20.6" cy="11" r="1.1" />
      </g>
    </svg>
  );
}

/** Садовый набор: от увядшего к цветущему. */
function GardenGradeIcon({ grade }: { grade: Grade }) {
  if (grade === "again") {
    return (
      <svg className="grade-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M4 4 C9 6 10 10 8 15" fill="none" stroke="var(--again-text)" strokeWidth="1.6" />
        <ellipse
          cx="6.5"
          cy="7.5"
          rx="3.4"
          ry="1.6"
          transform="rotate(35 6.5 7.5)"
          fill="var(--again-text)"
          opacity="0.75"
        />
      </svg>
    );
  }
  if (grade === "hard") {
    return (
      <svg className="grade-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <ellipse cx="9" cy="10" rx="3.2" ry="4.6" fill="var(--hard-text)" />
        <path d="M9 14 L9 17" stroke="var(--hard-text)" strokeWidth="1.4" />
      </svg>
    );
  }
  if (grade === "good") {
    return (
      <svg className="grade-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M9 17 C9 10 9 7 9 2" stroke="var(--good-text)" strokeWidth="1.4" fill="none" />
        <path d="M9 9 C4 7 3 3 3 3 C3 3 8 3 9 9 Z" fill="var(--good-text)" />
      </svg>
    );
  }
  return (
    <svg
      className="grade-icon"
      viewBox="-9 -9 18 18"
      color="var(--ornament-accent)"
      aria-hidden="true"
      focusable="false"
    >
      <use href="#flower" />
    </svg>
  );
}

/** Картинка на итогах: в светлой теме росток, в тёмной — огонёк. */
export function MoodPlant({ mood }: { mood: "weak" | "strong" }) {
  return useDark() ? <DeepMood mood={mood} /> : <GardenMood mood={mood} />;
}

function DeepMood({ mood }: { mood: "weak" | "strong" }) {
  if (mood === "weak") {
    return (
      <svg className="mood-plant" viewBox="0 0 110 110" aria-hidden="true" focusable="false">
        <circle
          cx="55"
          cy="55"
          r="34"
          fill="none"
          stroke="var(--again-line)"
          strokeWidth="1"
          strokeDasharray="2 5"
        />
        <circle cx="55" cy="55" r="7" fill="none" stroke="var(--again-text)" strokeWidth="1.4" />
        <g stroke="var(--again-line)" strokeWidth="1.4">
          <path d="M55 20 L55 30" />
          <path d="M55 80 L55 90" />
          <path d="M20 55 L30 55" />
          <path d="M80 55 L90 55" />
        </g>
      </svg>
    );
  }
  return (
    <svg className="mood-plant" viewBox="0 0 110 110" aria-hidden="true" focusable="false">
      <g stroke="var(--accent)" strokeWidth="1.8" fill="none" opacity="0.85">
        <path d="M55 55 C 40 46 34 30 40 16" />
        <path d="M55 55 C 68 44 76 28 70 14" />
        <path d="M55 55 C 44 68 42 86 52 98" />
        <path d="M55 55 C 68 66 74 84 66 98" />
      </g>
      <circle cx="55" cy="55" r="22" fill="var(--glow)" />
      <circle cx="55" cy="55" r="14" fill="var(--accent-dark)" opacity="0.9" />
      <circle cx="55" cy="55" r="6.5" fill="var(--text)" />
    </svg>
  );
}

function GardenMood({ mood }: { mood: "weak" | "strong" }) {
  if (mood === "weak") {
    return (
      <svg className="mood-plant" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <path d="M60 108 C 58 78 62 58 48 40" fill="none" stroke="var(--text-soft)" strokeWidth="3" />
        <path d="M48 40 C 34 42 26 34 24 24 C 36 24 46 30 48 40 Z" fill="var(--text-soft)" />
        <path d="M60 60 C 72 56 78 46 78 36 C 66 38 58 46 58 58 Z" fill="var(--text-soft)" opacity="0.85" />
      </svg>
    );
  }
  return (
    <svg className="mood-plant" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <path d="M60 110 C 60 80 60 60 60 46" stroke="var(--good-text)" strokeWidth="3" fill="none" />
      <path d="M60 78 C 44 74 40 62 40 62 C 40 62 54 60 60 78 Z" fill="var(--good-text)" />
      <path d="M60 88 C 76 84 80 72 80 72 C 80 72 66 70 60 88 Z" fill="var(--good-text)" />
      <g transform="translate(60,38)" color="var(--ornament-accent)">
        <use href="#flower" width="56" height="56" x="-28" y="-28" />
      </g>
    </svg>
  );
}
