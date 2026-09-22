/**
 * Size limits shared by the input contracts and the scenario library.
 * A real knowledge base is hundreds of articles; the model never reads them all at once (see selectSources), only the record keeps them.
 */
export const MATERIAL_LIMIT = 400;
export const MATERIAL_CHARS = 400_000;
export const MATERIALS_TOTAL_CHARS = 4_000_000;
/** Requirements kept on one record: the union of what each dialogue's articles yielded. One grounding call still returns at most REQUIREMENT_LIMIT. */
export const RECORD_REQUIREMENT_LIMIT = 800;
/** Articles the model may pick for one dialogue from the table of contents. */
export const SOURCES_PER_DIALOGUE = 5;
