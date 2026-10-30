/** Одинаковые пределы для экспорта и импорта, в байтах UTF-8. */
export const BACKUP_LIMITS = {
  fileBytes: 32 * 1024 * 1024,
  unpackedBytes: 64 * 1024 * 1024,
};
export type BackupLimits = typeof BACKUP_LIMITS;

export function checkBackupFileSize(
  bytes: number,
  limits: BackupLimits = BACKUP_LIMITS,
): void {
  if (bytes > limits.fileBytes)
    throw new Error(
      `Файл копии слишком большой (максимум ${limits.fileBytes / 1024 / 1024} МиБ).`,
    );
}

export function checkBackupJsonSize(
  bytes: number,
  limits: BackupLimits = BACKUP_LIMITS,
): void {
  if (bytes > limits.unpackedBytes)
    throw new Error(
      `Распакованная копия слишком большая (максимум ${limits.unpackedBytes / 1024 / 1024} МиБ).`,
    );
}
