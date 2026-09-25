/**
 * Size limits shared by the input contracts, the card library and the model requests.
 * A real knowledge base is hundreds of articles; the model never reads them all at once (see selectSources), only the record keeps them.
 */
export const MATERIAL_LIMIT = 1000;
export const MATERIAL_CHARS = 400_000;
export const MATERIALS_TOTAL_CHARS = 4_000_000;
/** Requirements kept on one record: the sentences its cards cite (a preparation), or what older preparations grounded. */
export const RECORD_REQUIREMENT_LIMIT = 800;
/** A longer article is split into parts of at most this many characters, at paragraph boundaries, so any part fits one model call. */
export const MATERIAL_PART_CHARS = 12_000;
/** Articles the model may pick for one dialogue from the table of contents, and how much of them one dialogue's calls may carry. */
export const SOURCES_PER_DIALOGUE = 5;
export const SELECTED_SOURCE_CHARS = 90_000;
/** UTF-8/JSON budget leaves room for the agent's prompts, the dialogue and repair feedback. */
export const SELECTED_SOURCE_BYTES = 96_000;
/** Units of a preparation worked on at once: the provider takes parallel calls, and a unit mostly waits on its model. */
export const PREPARATION_PARALLEL = 4;
export const MAX_PREPARATION_PARALLEL = 8;
/** The largest dialogue file Lab reads whole: a JSON document or a spreadsheet. */
export const IMPORT_FILE_BYTES = 4_000_000;
/**
 * A JSON Lines log is read in a stream, a line at a time, so it may be far larger: Lab keeps only the sample and one
 * id per conversation. Above these it is not a log of one agent's period but an archive to cut by date first.
 */
export const STREAMED_LOG_BYTES = 256_000_000;
export const LOG_CONVERSATIONS = 100_000;
/** Dialogues one import batch takes; a longer log gives a sample of this many (scenario-library.ts logImport). */
export const IMPORT_DIALOGUE_LIMIT = 300;
/**
 * The JSON of the conversations one import keeps, all together. A log whose conversations hold more — many long ones —
 * gives a sample, as a log of more than IMPORT_DIALOGUE_LIMIT conversations does: the same outcome-blind order, cut
 * where the next conversation would not fit. The import is never refused for it.
 */
export const IMPORT_BATCH_CHARS = 12_000_000;
/** The JSON of one logged conversation an import keeps; a larger one is left out of the import, with that reason. */
export const LOGGED_CONVERSATION_CHARS = 500_000;
/** A logged message longer than this is a document pasted in, not a message: its conversation is left out, with that reason. */
export const LOGGED_MESSAGE_CHARS = 8000;
/**
 * Later customer messages one situation accounts for (card/schema.ts `coverage`), and so the customer messages of a
 * logged conversation a situation can be made from: its opening and those. The one bound on a conversation's length,
 * in the card's own terms, never in raw events: a longer conversation is still read and counted in the traffic of its
 * topic; only no situation is made of it. Long conversations are where agents lose customers, so the bound is the
 * card's, never the sample's convenience; a conversation too large for one model call is left out later, with that
 * reason (card/prepare.ts).
 */
export const CARD_LATER_MESSAGES = 60;
export const LOGGED_CUSTOMER_MESSAGES = CARD_LATER_MESSAGES + 1;
/**
 * The data one model request carries, in UTF-8 bytes of its JSON: the role prompt, the answer's schema and a repair's
 * feedback come on top. Sized for today's long-context models (≈60–90 thousand tokens of Russian text): a card built
 * on the agent's prompts, its articles and a long dialogue must be proposed and reviewed whole, because dropping the
 * situations that do not fit would drop exactly the long conversations and bias the sample.
 */
export const MODEL_INPUT_BYTES = 240_000;
/** The whole request of a bounded task: the data above plus the role prompt, the schema and a repair's feedback. */
export const MODEL_REQUEST_BYTES = MODEL_INPUT_BYTES + 32_000;
export const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Why a request's data is too large for one model call; undefined when it fits. The source stays stored, only its call is not made. */
export function workInputIssue(value: unknown): string | undefined {
  const size = serializedBytes(value);
  return size > MODEL_INPUT_BYTES ? `Полная хронология и правила занимают ${size} байт; предел запроса ${MODEL_INPUT_BYTES}. Источник сохранён, но не обработан.` : undefined;
}
