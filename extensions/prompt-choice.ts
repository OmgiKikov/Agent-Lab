import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { settingsSchema } from '../src/contracts.js';
import { promptLine } from '../src/detect.js';
import type { ExperimentLab } from '../src/experiment.js';
import type { PromptCandidate } from '../src/prompt-candidates.js';
import { proposedPrompts, proposePurposes, purposeCallsText, purposeConsentLine, purposeKey, purposeLine, type ProposedPrompt, type PurposeProposal } from '../src/prompt-purpose.js';
import { clip, oneLine, safeText } from '../src/text.js';

/*
 * Which of the prompts Lab found are the bot's rules: the owner's choice, in one native list they tick through. A ticked
 * prompt becomes a material of kind `prompt`: every situation reads it whole and cites its rules of the bot's behaviour (docs:
 * «правила поведения бота»). With the chat's model the same list offers, once, to let Lab read the prompts' beginnings
 * and mark the ones that write the reply to the customer (prompt-purpose.ts): the proposal ticks them and gives every
 * line its purpose and reason, and the owner still confirms or changes each tick. A proposal made before for the same
 * prompts and model is reused for free; without a model nothing is ticked in advance.
 */

/** Candidates offered in one list; more are named in the chat. */
const OFFERED = 30;
const TITLE = 'Какие промпты задают, что и как бот отвечает клиенту?\n\nОтмеченные станут правилами поведения бота. Промпты классификаторов, извлечения данных и служебных проверок не отмечайте — по ним бота не судят.';
const PROPOSED = 'Lab отметил ✓ промпты, которые, по его чтению, пишут ответ клиенту. Проверьте: отмеченные станут правилами поведения бота, остальные — нет.';

/** One candidate in the list: ticked or not, its number, what and where it is, and its purpose when Lab proposed one, else how it begins. */
export const promptOption = (candidate: PromptCandidate, index: number, ticked: boolean, proposed?: ProposedPrompt): string =>
  safeText(`${ticked ? '✓' : '○'} ${index + 1}. ${promptLine(candidate)} — ${proposed ? purposeLine(proposed) : `«${clip(oneLine(candidate.text), 70)}»`}`);
/** The one offer to let Lab propose, with what it costs. */
export const proposeOption = (candidates: readonly PromptCandidate[]): string => `Пусть Lab отметит сам — прочитает начало промптов: ${purposeCallsText(candidates)} модели`;

/** Lab's proposal for the list: made already, or made now at the owner's word. */
export interface PromptProposer { proposal?: PurposeProposal; propose?: () => Promise<PurposeProposal> }

/** The owner's pick among `candidates`; `declined` when they stepped back. An empty pick means «без промптов». */
export async function choosePrompts(ctx: Pick<ExtensionContext, 'ui'>, candidates: readonly PromptCandidate[], proposer: PromptProposer = {}): Promise<PromptCandidate[] | 'declined'> {
  let proposal = proposer.proposal;
  let order: ProposedPrompt[] = [];
  const chosen = new Set<string>();
  const apply = () => {
    order = proposedPrompts(candidates, proposal).slice(0, OFFERED);
    chosen.clear();
    for (const item of order) if (item.suggested) chosen.add(item.candidate.id);
  };
  apply();
  const more = candidates.length > OFFERED ? `\n\nПоказаны первые ${OFFERED} из ${candidates.length}; остальные можно назвать в чате.` : '';
  while (true) {
    const done = chosen.size ? `Готово — взять отмеченные: ${chosen.size}` : 'Без промптов — только база знаний';
    const offer = !proposal && proposer.propose ? proposeOption(candidates) : undefined;
    const labels = order.map((item, index) => promptOption(item.candidate, index, chosen.has(item.candidate.id), proposal ? item : undefined));
    const options = [done, ...(offer ? [offer] : []), ...labels, 'Не сейчас'];
    const head = proposal ? `${TITLE.split('\n\n')[0]}\n\n${PROPOSED}${proposal.failure ? ' Часть промптов модель не разобрала — их назначение не определено.' : ''}`
      : offer ? `${TITLE}\n\n${purposeConsentLine(candidates)}` : TITLE;
    const picked = await ctx.ui.select(safeText(`${head}${more}`), options);
    if (picked === undefined || picked === 'Не сейчас') return 'declined';
    if (picked === done) return order.filter(item => chosen.has(item.candidate.id)).map(item => item.candidate);
    if (offer && picked === offer) { proposal = await proposer.propose!(); apply(); continue; }
    const item = order[labels.indexOf(picked)];
    if (!item) return 'declined';
    if (chosen.has(item.candidate.id)) chosen.delete(item.candidate.id); else chosen.add(item.candidate.id);
  }
}

/**
 * The owner's pick with Lab's proposal when the chat's model can make one: a stored proposal for these prompts and this
 * model is shown at once; otherwise the list offers to make it, and the one made is stored for the next look. `lab`
 * is the writer the caller holds for the length of the choice.
 */
export async function choosePromptsWithLab(ctx: Pick<ExtensionContext, 'ui' | 'model'>, lab: ExperimentLab, candidates: readonly PromptCandidate[], signal: AbortSignal): Promise<PromptCandidate[] | 'declined'> {
  const settings = ctx.model && settingsSchema.parse({ provider: ctx.model.provider, model: ctx.model.id });
  // A model Pi cannot reach now proposes nothing: the owner still ticks the list by hand, as without a model.
  const reader = settings && (await lab.modelRuntime(settings).catch(() => undefined))?.promptPurposes;
  if (!settings || !reader) return choosePrompts(ctx, candidates);
  const stored = await lab.store.readPromptPurposes(purposeKey(candidates, reader.builder));
  return choosePrompts(ctx, candidates, stored ? { proposal: stored } : {
    propose: async () => {
      const made = await proposePurposes(candidates, reader, { timeoutMs: settings.timeoutMs, signal });
      await lab.store.writePromptPurposes(made);
      return made;
    },
  });
}
