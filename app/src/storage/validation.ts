/** Проверки на границе JSON: TS-типы не проверяют файлы пользователя. */
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const integer = (value: unknown): value is number => number(value) && Number.isInteger(value);
export const date = (value: unknown): value is string => text(value) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const nullableText = (value: unknown) => value === null || typeof value === "string";
const member = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value);
export const state = (value: unknown) => member(value, ["new", "learning", "review", "relearning"]);

export function validCard(value: unknown): boolean {
  if (!object(value)) return false;
  return text(value.id) && value.type === "cloze" && text(value.text) && value.text.split("___").length === 2 &&
    text(value.answer) && strings(value.accept) && value.accept.length > 0 &&
    strings(value.answers) && value.answers.length > 0 && text(value.hint) && strings(value.also) &&
    nullableText(value.translation) && nullableText(value.note) && text(value.phrase) && member(value.relation, ["adj+noun", "verb+obj", "noun+verb", "noun+noun", "adv+verb", "adv+adj", "verb+adj", "quant+noun", "adv+other", "prep", "phrase", "other"]) &&
    text(value.headword) && nullableText(value.sense) && (value.cefr === null || member(value.cefr, ["A1", "A2", "B1", "B2", "C1", "C2"])) &&
    member(value.band, ["core", "common", "extended", "rare"]) &&
    member(value.ambiguity, ["low", "medium", "high"]) && strings(value.flags) && integer(value.position) && value.position > 0;
}

export function validProgress(value: unknown): boolean {
  if (!object(value)) return false;
  return text(value.cardId) && text(value.deckId) && state(value.state) && date(value.due) &&
    number(value.stability) && number(value.difficulty) && value.difficulty <= 10 &&
    number(value.elapsedDays) && number(value.scheduledDays) && integer(value.reps) && integer(value.lapses) &&
    value.lapses <= value.reps &&
    (value.state === "new" ? value.lastReview === null && value.reps === 0 : date(value.lastReview)) &&
    (value.suspended === undefined || typeof value.suspended === "boolean") &&
    (value.buriedUntil == null || date(value.buriedUntil));
}

export function validReview(value: unknown): boolean {
  if (!object(value)) return false;
  return text(value.cardId) && date(value.reviewedAt) && member(value.grade, ["again", "hard", "good", "easy"]) &&
    state(value.stateBefore) && number(value.elapsedDays) && number(value.scheduledDays) &&
    (value.id === undefined || integer(value.id)) && (value.eventId === undefined || text(value.eventId)) &&
    (value.undone === undefined || typeof value.undone === "boolean") &&
    (value.typed === undefined || typeof value.typed === "string") &&
    (value.verdict === undefined || member(value.verdict, ["correct", "almost", "wrong"])) &&
    (value.durationMs === undefined || number(value.durationMs));
}

export function validStudySettings(value: unknown): boolean {
  if (!object(value)) return false;
  for (const key of ["newPerDay", "reviewsPerDay", "siblingGap", "againGap", "hardGap"]) {
    if (value[key] !== undefined && !integer(value[key])) return false;
  }
  return (value.requestRetention === undefined || (number(value.requestRetention) && value.requestRetention > 0 && value.requestRetention < 1)) &&
    (value.repeatHard === undefined || typeof value.repeatHard === "boolean") &&
    (value.acceptTypos === undefined || typeof value.acceptTypos === "boolean");
}

export function validStoredDeck(value: unknown): boolean {
  return object(value) && text(value.id) && text(value.name) && text(value.version) && value.language === "en" &&
    value.cardType === "cloze" && integer(value.count) && date(value.builtAt) && date(value.importedAt);
}

export function validDeckMeta(value: unknown): boolean {
  if (!object(value) || !text(value.id) || !/^[a-z0-9-]+$/.test(value.id) || !text(value.name) || !text(value.version) ||
    value.language !== "en" || value.card_type !== "cloze" || !date(value.built_at) || !integer(value.count) ||
    !strings(value.chunks) || !value.chunks.every(chunk => /^cards-\d{3}(-[0-9a-f]{16})?\.json$/.test(chunk)) ||
    new Set(value.chunks).size !== value.chunks.length) return false;
  // Только старые имена допускаются без контрольных сумм ради совместимости.
  if (value.integrity === undefined) return value.chunks.every(chunk => /^cards-\d{3}\.json$/.test(chunk));
  if (!object(value.integrity) || value.integrity.algorithm !== "sha256-canonical-json-v1" || !object(value.integrity.chunks)) return false;
  const hashes = value.integrity.chunks;
  return Object.keys(hashes).length === value.chunks.length && value.chunks.every(chunk => {
    const hash = hashes[chunk];
    const suffix = /-([0-9a-f]{16})\.json$/.exec(chunk)?.[1];
    return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) && (suffix === undefined || hash.startsWith(suffix));
  });
}

export function uniqueIds(rows: unknown[], key: string): boolean {
  const ids = rows.map(row => object(row) ? row[key] : undefined);
  return new Set(ids).size === ids.length;
}
