/*
 * How de-identified exports hide what a customer wrote. The marks are an external convention with no structure —
 * whatever the export's masking tool writes — so this module is the one place that reads them, as llm/model-call.ts
 * is for providers' error phrases. Both readings are frozen: the import's decides which rows a stored import holds,
 * and the exclusion's decides what a stored topic map and sample left out, so a change would read old logs anew.
 *
 *   ***, ###                       symbols written over a value
 *   xxxx, хххх                     Latin or Cyrillic x over a value (the import's reading)
 *   [redacted] [masked] [скрыто] [удалено]
 *   <PHONE>, <ФИО>                 a tag in angle brackets
 */

const MASK_ONLY = /^(?:\s|\*|x|х|\[(?:redacted|masked|скрыто|удалено)\]|<[^>]+>)+$/i;

/** A message made of masking marks and spaces only: nothing the customer wrote is left. */
export const maskedThrough = (content: string): boolean => MASK_ONLY.test(content);

/** A message hidden by masking symbols: a `*` or `#` and not one letter or digit left. */
export const hiddenBySymbols = (content: string): boolean => /[*#]/u.test(content) && !/[\p{L}\p{N}]/u.test(content);
