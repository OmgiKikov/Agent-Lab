import { semanticFindingSchema, type ScenarioLibrary, type SemanticFinding } from './scenario-contracts.js';
import { semanticContentHash, semanticPaths, recordSemanticAssessment } from './scenario-library.js';
import { fingerprint, type CallContext, type Runtime, type ScenarioAssessmentInput } from './contracts.js';

/** Conservative UTF-8 data envelopes, leaving prompt/schema and transport overhead outside the body budget. */
export const SCENARIO_INPUT_BYTES = 64_000;
export const SCENARIO_OUTPUT_BYTES = 12_000;
export const SEMANTIC_REASON_CHARS = 240;
export const SEMANTIC_BATCH_FIELDS = 6;
export const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function workInputIssue(value: unknown): string | undefined {
  const size = serializedBytes(value);
  return size > SCENARIO_INPUT_BYTES ? `Полная хронология и правила занимают ${size} байт; предел запроса ${SCENARIO_INPUT_BYTES}. Источник сохранён, но не обработан.` : undefined;
}
type Job = { input: ScenarioAssessmentInput; outputBytes: number };
const relationPaths = ['businessScenarioId', 'duplicates'];
function responseBound(fields: ScenarioAssessmentInput['fields']): number {
  // Six escaped bytes per UTF-16 unit is the maximum JSON expansion of an arbitrary reason.
  return serializedBytes({ findings: fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'needs_review', reason: '\0'.repeat(SEMANTIC_REASON_CHARS) }))) });
}
export function planSemanticWork(library: ScenarioLibrary): { contentHash: string; jobs: Job[]; skipped: SemanticFinding[] } {
  const contentHash = semanticContentHash(library), jobs: Job[] = [], skipped: SemanticFinding[] = [];
  const context = (ids: string[], fullEvidence: boolean): ScenarioAssessmentInput['library'] => {
    const variants = library.variants.filter(v => ids.includes(v.id));
    const businessScenarios = library.businessScenarios.filter(b => variants.some(v => v.businessScenarioId === b.id));
    const requirements = library.requirements.filter(r => businessScenarios.some(b => b.requirementIds.includes(r.id)) || variants.some(v => v.evaluationSpec.checkpoints.some(c => c.requirementId === r.id)));
    const refs = variants.flatMap(v => [...v.sourceDialogues, ...v.userState.facts.flatMap(f => f.origin.kind === 'dialogue' ? [f.origin] : [])]);
    return { variants, businessScenarios, requirements, sources: fullEvidence ? library.sources.filter(s => requirements.some(r => r.sourceId === s.id)) : [],
      imports: fullEvidence ? library.imports.flatMap(batch => {
        const dialogues = batch.dialogues.filter(d => refs.some(r => r.batchId === batch.id && r.dialogueId === d.id))
          .map(({ id, events, observation }) => ({ id, events, observation }));
        return dialogues.length ? [{ id: batch.id, dialogues }] : [];
      }) : [] };
  };
  const make = (ids: string[], fields: ScenarioAssessmentInput['fields'], scope: ScenarioAssessmentInput['scope'], candidates: ScenarioAssessmentInput['comparisonCandidates'] = []): ScenarioAssessmentInput => ({
    protocol: 'chronological-scenarios-v1', contentHash, scope, library: context(ids, scope === 'fields'), fields, comparisonCandidates: candidates,
  });
  const add = (input: ScenarioAssessmentInput) => {
    const issue = workInputIssue(input), outputBytes = responseBound(input.fields);
    if (issue || outputBytes > SCENARIO_OUTPUT_BYTES) {
      skipped.push(...input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'needs_review' as const, reason: issue ?? 'Ответ не помещается в допустимый объём смысловой проверки.' }))));
      return;
    }
    jobs.push({ input, outputBytes });
  };
  for (const variant of library.variants) {
    const paths = semanticPaths(variant).filter(path => !relationPaths.includes(path));
    for (let offset = 0; offset < paths.length; offset += SEMANTIC_BATCH_FIELDS) add(make([variant.id], [{ variantId: variant.id, paths: paths.slice(offset, offset + SEMANTIC_BATCH_FIELDS) }], 'fields'));
  }
  const candidates = library.variants.map(v => {
    const business = library.businessScenarios.find(b => b.id === v.businessScenarioId)!;
    return { id: v.id, business: { goal: business?.goal ?? '', conditions: business?.conditions ?? [], requirementIds: business?.requirementIds ?? [] },
      goal: v.userState.goal, opening: v.userState.opening, facts: v.userState.facts.filter(f => f.availability === 'initial').map(({ statement, value }) => ({ statement, ...(value === undefined ? {} : { value }) })), purpose: v.purpose };
  });
  // Every target is compared against every bounded candidate block; findings are reduced conservatively across blocks.
  for (let offset = 0; offset < library.variants.length; offset += 3) {
    const targets = library.variants.slice(offset, offset + 3).map(v => v.id), fields = targets.map(variantId => ({ variantId, paths: relationPaths }));
    let block: typeof candidates = [];
    for (const candidate of candidates) {
      if (block.length && workInputIssue(make(targets, fields, 'relations', [...block, candidate]))) { add(make(targets, fields, 'relations', block)); block = []; }
      const single = make(targets, fields, 'relations', [candidate]);
      if (workInputIssue(single)) { add(single); continue; }
      block.push(candidate);
    }
    if (block.length) add(make(targets, fields, 'relations', block));
  }
  return { contentHash, jobs, skipped };
}

/** Same bounded plan for initial extraction and explicit reassessment. Each completed call has a persisted partial receipt. */
export async function assessScenarioLibrary(library: ScenarioLibrary, runtime: Pick<Runtime, 'assessScenarioProposals'>, ctx: CallContext,
  persist: (partial: ScenarioLibrary) => Promise<void>): Promise<ScenarioLibrary> {
  if (!runtime.assessScenarioProposals) throw new Error('Смысловая проверка недоступна.');
  const plan = planSemanticWork(library), findings = new Map<string, SemanticFinding>(), relationResults = new Map<string, SemanticFinding>();
  const receipts = new Map((library.semanticAssessment?.contentHash === plan.contentHash ? library.semanticAssessment.workReceipts ?? [] : []).map(r => [r.workHash, r]));
  const key = (f: { variantId: string; path: string }) => `${f.variantId}/${f.path}`;
  for (const finding of plan.skipped) findings.set(key(finding), finding);
  const remaining = new Map<string, number>();
  for (const job of plan.jobs.filter(j => j.input.scope === 'relations')) for (const field of job.input.fields) for (const path of field.paths) {
    const id = key({ variantId: field.variantId, path }); remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  const severity = { ready: 0, needs_review: 1, blocked: 2 };
  let revision = library.revision;
  const partial = () => ({ ...library, revision: ++revision, acceptance: undefined, semanticRequired: true as const,
    variants: library.variants.map(v => ({ ...v, ownerDecision: 'pending' as const })), semanticAssessment: { contentHash: plan.contentHash, findings: [...findings.values()], workReceipts: [...receipts.values()] } });
  await persist(partial());
  for (const job of plan.jobs) {
    ctx.signal.throwIfAborted();
    const workHash = fingerprint({ contentHash: plan.contentHash, scope: job.input.scope, fields: job.input.fields, candidates: job.input.comparisonCandidates.map(c => c.id) }), receipt = receipts.get(workHash);
    const raw = receipt?.findings ?? await runtime.assessScenarioProposals(job.input, ctx);
    if (serializedBytes({ findings: raw }) > SCENARIO_OUTPUT_BYTES) throw new Error('Смысловой ответ превышает допустимый объём. Частичные проверки сохранены.');
    const returned = raw.map(f => semanticFindingSchema.parse(f));
    if (returned.some(f => f.reason.length > SEMANTIC_REASON_CHARS)) throw new Error('Обоснование смысловой проверки превышает допустимую длину.');
    const expected = job.input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path })));
    if (returned.length !== expected.length || expected.some(f => returned.filter(r => key(r) === key(f)).length !== 1)) throw new Error('Смысловой ответ не покрывает ровно запрошенные поля. Частичные проверки сохранены.');
    receipts.set(workHash, { workHash, findings: returned });
    for (const finding of returned) {
      const id = key(finding);
      if (job.input.scope === 'fields') findings.set(id, finding);
      else {
        const previous = relationResults.get(id);
        if (!previous || severity[finding.status] > severity[previous.status]) relationResults.set(id, finding);
        remaining.set(id, remaining.get(id)! - 1);
        if (!findings.has(id) || findings.get(id)!.reason.startsWith('Сравнение ещё')) {
          findings.set(id, remaining.get(id) ? { ...finding, status: 'needs_review', reason: 'Сравнение ещё не охватило все варианты библиотеки.' } : relationResults.get(id)!);
        }
      }
    }
    if (!receipt) await persist(partial());
  }
  return recordSemanticAssessment({ ...library, revision }, [...findings.values()]);
}
