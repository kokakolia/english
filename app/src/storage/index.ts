/**
 * Локальное хранилище.
 *
 * Сервера нет: всё, что человек выучил, лежит только здесь. Отсюда два
 * свойства, ради которых слой и написан отдельно от интерфейса.
 *
 * Обновление колоды не трогает прогресс: содержимое и выученное лежат в разных
 * таблицах и связаны только идентификатором карточки.
 *
 * Ответ фиксируется атомарно: новое расписание и запись журнала пишутся одной
 * транзакцией до анимации, а не после.
 */

export {
  AppDatabase,
  getDatabase,
  setDatabase,
  type SettingRow,
  type StoredCard,
  type StoredDeck,
  type StoredProgress,
  type StoredReview,
} from "./db";

export {
  importDeck,
  listDecks,
  loadCards,
  removeDeck,
  type DeckFile,
  type DeckMeta,
  type ImportOptions,
  type ImportResult,
} from "./decks";

export {
  studiedToday,
  cardHistory,
  deckCounts,
  getProgress,
  loadProgress,
  buryCard,
  hiddenCount,
  recordReview,
  resetCard,
  restoreProgress,
  suspendCard,
  undoReview,
  unsuspendCard,
  type DeckCounts,
  type HideInput,
  type PreviousProgress,
  type ReviewInput,
  type ReviewResult,
  type UndoInput,
} from "./study";

export {
  DEFAULT_STUDY_SETTINGS,
  getSetting,
  getStudySettings,
  setSetting,
  updateStudySettings,
  type StudySettings,
} from "./settings";

export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  backupFileName,
  exportBackup,
  exportBackupJson,
  restoreBackup,
  type BackupFile,
  type ExportOptions,
  type RestoreMode,
  type RestoreOptions,
  type RestoreResult,
} from "./backup";

export {
  DeckLoadError,
  loadDeckFile,
  loadDeckIndex,
  type DeckIndexEntry,
  type FetchLike,
} from "./loader";
