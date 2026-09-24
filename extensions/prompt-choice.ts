import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { promptLine } from '../src/detect.js';
import type { PromptCandidate } from '../src/prompt-candidates.js';
import { clip, oneLine, safeText } from '../src/text.js';

/*
 * Which of the prompts Lab found are the bot's rules: the owner's choice, in one native list they tick through. Nothing
 * is ticked in advance — Lab cannot tell a prompt that forms the reply to the customer from a classifier by its name —
 * and nothing is read by a model here. A ticked prompt becomes a material of kind `prompt`: its rules are grounded
 * as the rules of the bot's behaviour (docs: «правила поведения бота»).
 */

/** Candidates offered in one list; more are named in the chat. */
const OFFERED = 30;
const TITLE = 'Какие промпты задают, что и как бот отвечает клиенту?\n\nОтмеченные станут правилами поведения бота. Промпты классификаторов, извлечения данных и служебных проверок не отмечайте — по ним бота не судят.';

/** One candidate in the list: ticked or not, its number, what and where it is, how it begins. */
export const promptOption = (candidate: PromptCandidate, index: number, ticked: boolean): string =>
  safeText(`${ticked ? '✓' : '○'} ${index + 1}. ${promptLine(candidate)} — «${clip(oneLine(candidate.text), 70)}»`);

/** The owner's pick among `candidates`; `declined` when they stepped back. An empty pick means «без промптов». */
export async function choosePrompts(ctx: Pick<ExtensionContext, 'ui'>, candidates: readonly PromptCandidate[]): Promise<PromptCandidate[] | 'declined'> {
  const offered = candidates.slice(0, OFFERED);
  const chosen = new Set<string>();
  const label = (candidate: PromptCandidate, index: number) => promptOption(candidate, index, chosen.has(candidate.id));
  const more = candidates.length > offered.length ? `\n\nПоказаны первые ${OFFERED} из ${candidates.length}; остальные можно назвать в чате.` : '';
  while (true) {
    const done = chosen.size ? `Готово — взять отмеченные: ${chosen.size}` : 'Без промптов — только база знаний';
    const options = [done, ...offered.map(label), 'Не сейчас'];
    const picked = await ctx.ui.select(safeText(`${TITLE}${more}`), options);
    if (picked === undefined || picked === 'Не сейчас') return 'declined';
    if (picked === done) return offered.filter(candidate => chosen.has(candidate.id));
    const candidate = offered[options.indexOf(picked) - 1];
    if (!candidate) return 'declined';
    if (chosen.has(candidate.id)) chosen.delete(candidate.id); else chosen.add(candidate.id);
  }
}
