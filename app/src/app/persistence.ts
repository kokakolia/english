/**
 * Постоянное хранилище: чтобы браузер не стёр прогресс.
 *
 * IndexedDB по умолчанию живёт в режиме «best effort». Это значит ровно то,
 * что написано: браузер обязуется хранить данные, пока ему удобно, и вправе
 * выбросить их, когда на диске станет тесно. Для сайта, который можно
 * перезагрузить с сервера, это разумно. Для нашего случая — нет: прогресс
 * существует в одном экземпляре и восстановить его неоткуда.
 *
 * `navigator.storage.persist()` переводит хранилище в режим, из которого
 * данные удаляются только по явной команде пользователя. Chrome выдаёт это
 * разрешение молча, если приложение установлено как PWA или у него высокая
 * «вовлечённость»; иначе может отказать так же молча.
 *
 * Поэтому здесь не «запросили и забыли», а возврат настоящего ответа: экран
 * дня показывает его человеку. Обещать сохранность, не проверив, хуже, чем
 * честно сказать, что браузер разрешения не дал.
 */

export interface StorageStatus {
  /** Браузер умеет постоянное хранилище. */
  supported: boolean;
  /** Разрешение получено: данные не будут вытеснены автоматически. */
  persisted: boolean;
  /** Занято байт, если браузер сообщает. */
  usage: number | null;
  /** Сколько всего доступно байт, если браузер сообщает. */
  quota: number | null;
}

const UNSUPPORTED: StorageStatus = {
  supported: false,
  persisted: false,
  usage: null,
  quota: null,
};

/**
 * Запрашивает постоянное хранилище и возвращает, чем дело кончилось.
 *
 * Повторный вызов безопасен: если разрешение уже есть, `persist()` сразу
 * отвечает `true`, не показывая ничего пользователю.
 */
export async function ensurePersistentStorage(): Promise<StorageStatus> {
  const storage = navigator.storage as StorageManager | undefined;
  if (storage === undefined || typeof storage.persist !== "function") {
    return UNSUPPORTED;
  }

  let persisted = false;
  try {
    persisted = await storage.persisted();
    if (!persisted) persisted = await storage.persist();
  } catch {
    // Firefox в приватном окне бросает вместо отказа. Для нас это тот же
    // отказ, и падать из-за него приложение не должно.
    return { ...UNSUPPORTED, supported: true };
  }

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const estimate = await storage.estimate();
    usage = estimate.usage ?? null;
    quota = estimate.quota ?? null;
  } catch {
    // Оценка места — справочная величина; без неё можно жить.
  }

  return { supported: true, persisted, usage, quota };
}

/**
 * Запущено ли приложение как установленная программа.
 *
 * Нужно, чтобы не советовать установить то, что уже установлено. Chrome
 * открывает установленное приложение в режиме `standalone`; Safari на iOS
 * отвечает на тот же вопрос своим нестандартным свойством.
 */
export function isInstalled(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

/**
 * Что сказать человеку о хранилище.
 *
 * Отдельно от вёрстки и от обращений к браузеру, чтобы решение можно было
 * проверить тестом. Проверять тут есть что: совет «установите приложение»
 * бессмыслен тому, кто его уже установил, а именно так и вышло в первой
 * версии — она советовала установку всем подряд.
 */
export type StorageAdvice =
  /** Браузер не умеет постоянное хранилище вовсе. */
  | "unsupported"
  /** Разрешения нет, но установка приложения может его добыть. */
  | "install"
  /** Разрешения нет, и установка уже не поможет: остаётся копия в файле. */
  | "stuck"
  /** Всё в порядке. */
  | "ok";

export function storageAdvice(
  storage: StorageStatus | null,
  installed: boolean,
): StorageAdvice | null {
  if (storage === null) return null;
  if (!storage.supported) return "unsupported";
  if (storage.persisted) return "ok";
  return installed ? "stuck" : "install";
}

/** Стоит ли пометить кнопку меню: прогресс может быть вытеснен. */
export function storageAtRisk(storage: StorageStatus | null): boolean {
  return storage !== null && !storage.persisted;
}

/** Размер по-человечески: 4,9 МБ. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(".", ",")} МБ`;
  return `${(mb / 1024).toFixed(1).replace(".", ",")} ГБ`;
}
