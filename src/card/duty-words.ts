/*
 * How a duty reads for the owner wherever duties are listed — a situation's card and its row in a list, the plan, the
 * preview of a change, the board and the customer report: whether the agent must do it or must not, and what the judge
 * reads beside its words (when it applies, what else fulfils it, what breaks it). One place, so no surface drops the «не»
 * of a must-not duty or the condition of a conditional one. Pure.
 */

/** A duty as a surface lists it (card/view.ts Brief.must). */
export interface ListedDuty { text: string; forbidden?: boolean; when?: string; acceptable?: string; violation?: string }

/** What the agent is held to: «Агент должен», or «Агент не должен». */
export const dutyHeading = (duty: Pick<ListedDuty, 'forbidden'>): string => duty.forbidden ? 'Агент не должен' : 'Агент должен';

/** A duty in one line: «Агент не должен: называть ставку без номера терминала». */
export const dutyLine = (duty: Pick<ListedDuty, 'forbidden' | 'text'>): string => `${dutyHeading(duty)}: ${duty.text}`;

/** What the judge reads beside a duty's words, a line each: when it applies, what else fulfils it, what breaks it. */
export function dutyNotes(duty: ListedDuty): string[] {
  return [...(duty.when ? [`когда: ${duty.when}`] : []), ...(duty.acceptable ? [`допустимо: ${duty.acceptable}`] : []),
    ...(duty.violation ? [`нарушение: ${duty.violation}`] : [])];
}

/**
 * A card's duties under their headings — what the agent must do, then what it must not —, each keeping its number, its
 * place on the card, so «ожидание 2» names the same duty on every surface.
 */
export function dutySections<T extends Pick<ListedDuty, 'forbidden'>>(duties: readonly T[]): { heading: string; items: { number: number; duty: T }[] }[] {
  return [false, true].flatMap(forbidden => {
    const items = duties.flatMap((duty, index) => !!duty.forbidden === forbidden ? [{ number: index + 1, duty }] : []);
    return items.length ? [{ heading: dutyHeading({ forbidden }), items }] : [];
  });
}
