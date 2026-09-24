/**
 * Size limits shared by the input contracts, the card library and the model requests.
 * A real knowledge base is hundreds of articles; the model never reads them all at once (see selectSources), only the record keeps them.
 */
export const MATERIAL_LIMIT = 1000;
export const MATERIAL_CHARS = 400_000;
export const MATERIALS_TOTAL_CHARS = 4_000_000;
/** Requirements kept on one record: the union of what each dialogue's articles yielded. One grounding call still returns at most REQUIREMENT_LIMIT. */
export const RECORD_REQUIREMENT_LIMIT = 800;
/** A longer article is split into parts of at most this many characters, at paragraph boundaries, so any part fits one model call. */
export const MATERIAL_PART_CHARS = 12_000;
/** Articles the model may pick for one dialogue from the table of contents, and how much of them one dialogue's calls may carry. */
export const SOURCES_PER_DIALOGUE = 5;
export const SELECTED_SOURCE_CHARS = 30_000;
/** UTF-8/JSON budget leaves room for the dialogue, focused requirements and repair feedback. */
export const SELECTED_SOURCE_BYTES = 32_000;
/** Requirements one dialogue's grounding call may return: the rules that decide this dialogue, not the whole policy. */
export const FOCUSED_REQUIREMENT_LIMIT = 12;
/** The largest dialogue file Lab reads whole; a bigger log needs a smaller sample first. */
export const IMPORT_FILE_BYTES = 4_000_000;
/** Dialogues one import batch takes. */
export const IMPORT_DIALOGUE_LIMIT = 300;
/** The data one model request carries, in UTF-8 bytes of its JSON: the role prompt, the answer's schema and a repair's feedback come on top. */
const MODEL_INPUT_BYTES = 64_000;
export const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Why a request's data is too large for one model call; undefined when it fits. The source stays stored, only its call is not made. */
export function workInputIssue(value: unknown): string | undefined {
  const size = serializedBytes(value);
  return size > MODEL_INPUT_BYTES ? `Полная хронология и правила занимают ${size} байт; предел запроса ${MODEL_INPUT_BYTES}. Источник сохранён, но не обработан.` : undefined;
}
