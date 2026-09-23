/*
 * A leaf module with no imports, so every text module (result-view.ts, explain.ts, quality.ts)
 * can word a count without an import cycle.
 */

/** Russian plural form only: pluralForm(2, ['диалог', 'диалога', 'диалогов']) → «диалога». */
export function pluralForm(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10, mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? forms[1] : forms[2];
}
/** The count and its word: countText(2, ['диалог', 'диалога', 'диалогов']) → «2 диалога». */
export const countText = (n: number, forms: [string, string, string]): string => `${n} ${pluralForm(n, forms)}`;
