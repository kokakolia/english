/**
 * Схема локального хранилища.
 *
 * Всё живёт в браузере: сервера нет, и единственная копия прогресса — та, что
 * на устройстве. Отсюда два принципа, определяющих схему.
 *
 * Первый: **содержимое колоды и прогресс лежат в разных таблицах** и связаны
 * только идентификатором карточки. Обновление колоды переписывает `cards` и не
 * трогает `progress` — выученное не должно зависеть от того, пересобрали ли
 * файл колоды.
 *
 * Второй: **журнал повторений пишется сырьём и не переписывается**. Он не нужен
 * планировщику — тот работает с текущим состоянием карточки. Но из него потом
 * вырастут статистика, подгонка параметров FSRS под себя и синхронизация, а
 * восстановить его задним числом будет неоткуда.
 */

import Dexie, { type Table } from "dexie";

import type { CardProgress, DeckCard, ReviewEntry } from "../srs";

/** Метаданные импортированной колоды. */
export interface StoredDeck {
  id: string;
  name: string;
  /** Хэш содержимого из файла колоды: по нему видно, что она изменилась. */
  version: string;
  language: string;
  cardType: string;
  count: number;
  builtAt: string;
  importedAt: string;
  source?: Record<string, unknown>;
}

/** Карточка в хранилище — та же, что в файле, плюс принадлежность колоде. */
export type StoredCard = DeckCard & { deckId: string };

/**
 * Прогресс с указанием колоды.
 *
 * Колода продублирована здесь намеренно: без неё нельзя посчитать, сколько
 * карточек ждёт повторения в конкретной колоде, не вычитав все карточки.
 */
export type StoredProgress = CardProgress & { deckId: string };

/** Запись журнала. Идентификатор проставляет база. */
export type StoredReview = ReviewEntry & { id?: number };

export interface SettingRow {
  key: string;
  value: unknown;
}

export class AppDatabase extends Dexie {
  decks!: Table<StoredDeck, string>;
  cards!: Table<StoredCard, string>;
  progress!: Table<StoredProgress, string>;
  reviews!: Table<StoredReview, number>;
  settings!: Table<SettingRow, string>;

  constructor(name = "collocation-srs") {
    super(name);

    // Индексы выбраны по запросам, которые реально нужны экранам:
    // очередь дня ищет по сроку, список колод — по принадлежности,
    // будущая статистика — по дате повторения.
    this.version(1).stores({
      decks: "id, importedAt",
      cards: "id, deckId, position, headword, relation, band, cefr",
      progress: "cardId, deckId, due, state, [deckId+due]",
      reviews: "++id, cardId, reviewedAt, [cardId+reviewedAt]",
      settings: "key",
    });
  }
}

let current: AppDatabase | null = null;

/** База приложения. Создаётся один раз и переиспользуется. */
export function getDatabase(): AppDatabase {
  current ??= new AppDatabase();
  return current;
}

/** Подменить базу — нужно тестам и переключению профилей. */
export function setDatabase(database: AppDatabase | null): void {
  current = database;
}
