/**
 * Сохранение копии в файл без вопросов «куда».
 *
 * Обычная ссылка с `download` отдаёт файл на усмотрение браузера: он либо
 * молча кладёт его в «Загрузки», либо показывает диалог — зависит от настройки
 * браузера, которой приложение не управляет. Раз в неделю это терпимо, но
 * копию хочется делать часто, и лишний диалог каждый раз превращает полезную
 * привычку в морок.
 *
 * Поэтому здесь File System Access API: папка выбирается **один раз**,
 * дальше нажатие сохраняет молча. Выбирается именно папка, а не файл: в папку
 * ложатся копии с датой в имени, и история сохраняется. Одиночный файл
 * пришлось бы перезаписывать, и повреждённая копия не оставила бы запасной.
 *
 * Где API нет — Firefox, Safari — работает прежний путь со ссылкой. Это не
 * заглушка, а нормальный запасной вариант: файл всё равно сохраняется.
 */

import { getSetting, setSetting, type AppDatabase } from "../storage";

const FOLDER_KEY = "backupFolder";

/** Куда делась копия и пришлось ли о чём-то спрашивать. */
export type SaveOutcome =
  | { kind: "saved"; name: string; bytes: number; folder: string }
  | { kind: "downloaded"; name: string; bytes: number }
  | { kind: "cancelled" };

interface FileSystemPermissionDescriptor {
  mode?: "read" | "readwrite";
}

/**
 * Часть File System Access API, которой мы пользуемся.
 *
 * Своё описание вместо библиотечного: типы для этого API в TypeScript неполные
 * и расходятся между версиями, а нужны нам три метода.
 */
interface DirectoryHandle {
  name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    createWritable(): Promise<WritableStream<BufferSource | Blob>>;
  }>;
  queryPermission?(
    descriptor?: FileSystemPermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission?(
    descriptor?: FileSystemPermissionDescriptor,
  ): Promise<PermissionState>;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<DirectoryHandle>;
};

/** Умеет ли браузер сохранять в выбранную папку. */
export function canSaveSilently(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Сжимает текст в gzip. Копия из одного прогресса ужимается примерно втрое. */
export async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** Разжимает, если это gzip. Понимается по двум первым байтам. */
export async function gunzipIfNeeded(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return file.text();
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Папка для копий, выбранная раньше.
 *
 * Разрешение проверяется, а не предполагается: браузер вправе его отозвать —
 * например, после перезапуска, — и тогда запись упала бы с исключением на
 * ровном месте.
 */
async function rememberedFolder(
  db: AppDatabase,
  { mayAsk }: { mayAsk: boolean },
): Promise<DirectoryHandle | null> {
  const handle = await getSetting<DirectoryHandle | null>(db, FOLDER_KEY, null);
  if (
    typeof handle !== "object" ||
    handle === null ||
    typeof handle.getFileHandle !== "function" ||
    typeof handle.name !== "string"
  ) {
    if (handle !== null) await forgetFolder(db);
    return null;
  }

  try {
    const state =
      (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (state === "granted") return handle;
    if (!mayAsk) return null;

    // Спрашивать можно только внутри жеста пользователя, и мы в нём: сюда
    // приходят по нажатию кнопки.
    const asked =
      (await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
    return asked === "granted" ? handle : null;
  } catch {
    return null;
  }
}

/** Название запомненной папки — показать человеку, куда всё ложится. */
export async function savedFolderName(db: AppDatabase): Promise<string | null> {
  const handle = await rememberedFolder(db, { mayAsk: false });
  return handle?.name ?? null;
}

/** Забыть папку: следующее сохранение спросит заново. */
export async function forgetFolder(db: AppDatabase): Promise<void> {
  await setSetting(db, FOLDER_KEY, null);
}

/**
 * Сохраняет копию.
 *
 * Первый раз спрашивает папку, дальше пишет молча. Если API нет — отдаёт файл
 * ссылкой, как раньше.
 */
export async function saveBackupFile(
  db: AppDatabase,
  name: string,
  data: Blob,
): Promise<SaveOutcome> {
  const picker = (window as PickerWindow).showDirectoryPicker;

  if (picker !== undefined) {
    let folder = await rememberedFolder(db, { mayAsk: true });

    if (folder === null) {
      try {
        folder = await picker({
          id: "collocations-backups",
          mode: "readwrite",
          startIn: "documents",
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return { kind: "cancelled" };
        throw cause;
      }
      await setSetting(db, FOLDER_KEY, folder);
    }

    const file = await folder.getFileHandle(name, { create: true });
    const writer = (await file.createWritable()).getWriter();
    await writer.write(data);
    await writer.close();
    return { kind: "saved", name, bytes: data.size, folder: folder.name };
  }

  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return { kind: "downloaded", name, bytes: data.size };
}
