/**
 * Настройки занятий.
 *
 * Значения по умолчанию — разумные, но не выверенные: сколько новых карточек в
 * день выдержит конкретный человек, показывает только практика. Поэтому они
 * лежат в базе и меняются, а не зашиты в код.
 */

import type { AppDatabase } from "./db";

export interface StudySettings {
  /** Сколько новых карточек вводить за день. */
  newPerDay: number;
  /** Сколько повторений показывать за день. */
  reviewsPerDay: number;
  /** Минимальное число карточек между карточками одного гнезда. */
  siblingGap: number;
  /** Доля карточек, которые учащийся должен вспоминать успешно. */
  requestRetention: number;
  /** Через сколько карточек возвращать ту, на которой ошиблись. */
  againGap: number;
  /** Засчитывать ли ответ с опечаткой без переспроса. */
  acceptTypos: boolean;
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  newPerDay: 15,
  reviewsPerDay: 120,
  siblingGap: 4,
  requestRetention: 0.9,
  againGap: 3,
  acceptTypos: false,
};

const STUDY_KEY = "study";

export async function getSetting<T>(
  db: AppDatabase,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(
  db: AppDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  await db.settings.put({ key, value });
}

export async function getStudySettings(db: AppDatabase): Promise<StudySettings> {
  const stored = await getSetting<Partial<StudySettings>>(db, STUDY_KEY, {});
  // Слияние с умолчаниями, а не замена: добавленная в новой версии настройка
  // не должна оказаться неопределённой у того, кто уже что-то менял.
  return { ...DEFAULT_STUDY_SETTINGS, ...stored };
}

export async function updateStudySettings(
  db: AppDatabase,
  changes: Partial<StudySettings>,
): Promise<StudySettings> {
  const merged = { ...(await getStudySettings(db)), ...changes };
  await setSetting(db, STUDY_KEY, merged);
  return merged;
}
