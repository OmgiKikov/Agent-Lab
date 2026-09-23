import { semanticFindingSchema, type ScenarioLibrary, type SemanticFinding } from './scenario-contracts.js';
import { semanticContentHash, semanticPaths, recordSemanticAssessment, ownerFactEvidence } from './scenario-library.js';
import { fingerprint, type CallContext, type Runtime, type ScenarioAssessmentInput } from './contracts.js';

/** Conservative UTF-8 data envelopes, leaving prompt/schema and transport overhead outside the body budget. */
const SCENARIO_INPUT_BYTES = 64_000;
/** One whole scenario request: the data envelope plus its role prompt, output schema and repair feedback. */
export const SCENARIO_REQUEST_BYTES = 96_000;
export const SCENARIO_OUTPUT_BYTES = 12_000;
export const SEMANTIC_REASON_CHARS = 240;
export const SEMANTIC_BATCH_FIELDS = 6;
// Grounds business definitions locally in source evidence as well as comparing their grouping across cards.
export const SEMANTIC_CONTEXT_VERSION = 11;
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
    // Admission badges and edit chatter are not evidence. Verified owner facts have a separate receipt;
    // old requests and proposal history must not override the current definition or original source.
    const variants = library.variants.filter(v => ids.includes(v.id)).map(({ quality: _quality, issues: _issues, ownerDecision: _decision, semanticReviewRequired: _review, history: _history, revision: _revision, ...definition }) => ({
      ...definition, revision: 1, history: [], quality: 'needs_review' as const, issues: [], ownerDecision: 'pending' as const,
    }));
    const businessScenarios = library.businessScenarios.filter(b => variants.some(v => v.businessScenarioId === b.id));
    const requirements = library.requirements.filter(r => businessScenarios.some(b => b.requirementIds.includes(r.id)) || variants.some(v => v.evaluationSpec.checkpoints.some(c => c.requirementId === r.id)));
    const refs = variants.flatMap(v => [...v.sourceDialogues, ...(v.sourceCoverageBasis ?? []), ...v.userState.facts.flatMap(f => f.origin.kind === 'dialogue' ? [f.origin] : [])]);
    refs.push(...readingEvidence(library, ids).flatMap(row => row.batchId ? [{ batchId: row.batchId, dialogueId: row.dialogueId }] : []));
    const sourceIds = checkerSourceIds(library, variants.map(v => v.id));
    return { variants, businessScenarios, requirements, sources: fullEvidence ? library.sources.filter(s => sourceIds.includes(s.id)) : [],
      imports: fullEvidence ? library.imports.flatMap(batch => {
        const dialogues = batch.dialogues.filter(d => refs.some(r => r.batchId === batch.id && r.dialogueId === d.id))
          .map(({ id, events, observation }) => ({ id, events, observation }));
        return dialogues.length ? [{ id: batch.id, dialogues }] : [];
      }) : [] };
  };
  const make = (ids: string[], fields: ScenarioAssessmentInput['fields'], scope: ScenarioAssessmentInput['scope'], candidates: ScenarioAssessmentInput['comparisonCandidates'] = []): ScenarioAssessmentInput => ({
    protocol: 'chronological-scenarios-v1', contentHash, scope, library: context(ids, scope === 'fields'), fields, comparisonCandidates: candidates,
    ownerFactEvidence: library.variants.filter(v => ids.includes(v.id) || candidates.some(c => c.id === v.id)).flatMap(v => ownerFactEvidence(library, v)),
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
    // Group membership has two obligations: grounding in this source and consistency with other groups.
    // Its local result cannot be replaced by comparisons of generated definitions alone.
    const paths = semanticPaths(variant).filter(path => path !== 'duplicates');
    for (let offset = 0; offset < paths.length; offset += SEMANTIC_BATCH_FIELDS) add(make([variant.id], [{ variantId: variant.id, paths: paths.slice(offset, offset + SEMANTIC_BATCH_FIELDS) }], 'fields'));
  }
  const candidates = library.variants.map(v => {
    const business = library.businessScenarios.find(b => b.id === v.businessScenarioId)!;
    const { quality, issues, ownerDecision, semanticReviewRequired, history, revision, ...definition } = v;
    return { ...definition, revision: 1, history: [], business: { goal: business?.goal ?? '', conditions: business?.conditions ?? [], requirementIds: business?.requirementIds ?? [] } };
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

/** Articles the checker must see for these cards: cited requirements plus the reading manifest, which the card cannot shrink. */
export function checkerSourceIds(library: ScenarioLibrary, variantIds: string[]): string[] {
  const variants = library.variants.filter(variant => variantIds.includes(variant.id));
  const cited = library.requirements.filter(requirement => variants.some(variant => {
    const business = library.businessScenarios.find(item => item.id === variant.businessScenarioId);
    return business?.requirementIds.includes(requirement.id) || variant.evaluationSpec.checkpoints.some(checkpoint => checkpoint.requirementId === requirement.id);
  })).map(requirement => requirement.sourceId);
  const selected = readingEvidence(library, variantIds).flatMap(row => row.sourceIds);
  return [...new Set([...cited, ...selected])];
}

function readingEvidence(library: ScenarioLibrary, variantIds: string[]): NonNullable<ScenarioLibrary['readingManifest']> {
  const identities = new Set(variantIds);
  for (let remaining = library.variants.length; remaining > 0; remaining--) {
    const size = identities.size;
    for (const variant of library.variants) if (identities.has(variant.id) && variant.parentVariantId) identities.add(variant.parentVariantId);
    if (identities.size === size) break;
  }
  // Legacy manifests have no immutable card binding: retain all their readings conservatively.
  return (library.readingManifest ?? []).filter(row => !row.variantIds || row.variantIds.some(id => identities.has(id)));
}

/** A field job depends on its own cards and their articles. A relation job also depends on the candidates it compared. */
function semanticWorkHash(job: Job): string {
  // Hash the actual bounded request, excluding only the global bookkeeping identity.
  // This includes business conditions, requirements, chronology and authenticated owner evidence.
  const { contentHash: _global, ...input } = job.input;
  return fingerprint({ evidenceVersion: SEMANTIC_CONTEXT_VERSION, input });
}

function finalAssessmentCoversPlan(library: ScenarioLibrary, plan: ReturnType<typeof planSemanticWork>): boolean {
  const assessment = library.semanticAssessment;
  if (!assessment || assessment.contextVersion !== SEMANTIC_CONTEXT_VERSION || assessment.contentHash !== plan.contentHash) return false;
  if (assessment.workReceipts !== undefined) {
    const completed = new Set(assessment.workReceipts.map(receipt => receipt.workHash));
    if (!assessment.complete || plan.jobs.some(job => !completed.has(semanticWorkHash(job)))) return false;
  }
  return library.variants.every(variant => semanticPaths(variant).every(path =>
    assessment.findings.filter(finding => finding.variantId === variant.id && finding.path === path).length === 1));
}

/** Counts only calls that do not already have a receipt for this exact semantic content. */
export function semanticWorkStatus(library: ScenarioLibrary): {
  contentHash: string; totalJobs: number; completedJobs: number; pendingJobs: number; needsFinalization: boolean; skipped: SemanticFinding[];
} {
  const plan = planSemanticWork(library);
  const stored = library.semanticAssessment;
  const usable = !!stored && (stored.contextVersion === undefined || stored.contextVersion === SEMANTIC_CONTEXT_VERSION);
  const completed = new Set(usable ? (stored.workReceipts ?? []).map(receipt => receipt.workHash) : []);
  const completedJobs = finalAssessmentCoversPlan(library, plan) ? plan.jobs.length
    : plan.jobs.reduce((count, job) => count + Number(completed.has(semanticWorkHash(job))), 0);
  return { contentHash: plan.contentHash, totalJobs: plan.jobs.length, completedJobs,
    pendingJobs: plan.jobs.length - completedJobs, needsFinalization: library.variants.length > 0 && completedJobs === plan.jobs.length
      && !finalAssessmentCoversPlan(library, plan), skipped: plan.skipped };
}

/** Same bounded plan for initial extraction and explicit reassessment. Each completed call has a persisted partial receipt. */
export async function assessScenarioLibrary(library: ScenarioLibrary, runtime: Pick<Runtime, 'assessScenarioProposals'>, ctx: CallContext,
  persist: (partial: ScenarioLibrary) => Promise<void>): Promise<ScenarioLibrary> {
  if (!runtime.assessScenarioProposals) throw new Error('Смысловая проверка недоступна.');
  const plan = planSemanticWork(library), findings = new Map<string, SemanticFinding>(), results = new Map<string, SemanticFinding>();
  const stored = library.semanticAssessment;
  const usable = !!stored && (stored.contextVersion === undefined || stored.contextVersion === SEMANTIC_CONTEXT_VERSION);
  if (finalAssessmentCoversPlan(library, plan)) return structuredClone(library);
  const required = new Set(plan.jobs.map(semanticWorkHash));
  const receipts = new Map((usable ? stored.workReceipts ?? [] : []).filter(receipt => required.has(receipt.workHash)).map(r => [r.workHash, r]));
  const key = (f: { variantId: string; path: string }) => `${f.variantId}/${f.path}`;
  // An omitted evidence job remains uncertainty even if every executable comparison says ready.
  for (const finding of plan.skipped) { findings.set(key(finding), finding); results.set(key(finding), finding); }
  const remaining = new Map<string, number>();
  for (const job of plan.jobs) for (const field of job.input.fields) for (const path of field.paths) {
    const id = key({ variantId: field.variantId, path }); remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  const severity = { ready: 0, needs_review: 1, blocked: 2 };
  let revision = library.revision;
  const partial = () => ({ ...library, revision: ++revision, acceptance: undefined, semanticRequired: true as const,
    variants: library.variants.map(v => ({ ...v, ownerDecision: 'pending' as const })), semanticAssessment: { contextVersion: SEMANTIC_CONTEXT_VERSION, contentHash: plan.contentHash, findings: [...findings.values()], workReceipts: [...receipts.values()] } });
  await persist(partial());
  for (const job of plan.jobs) {
    ctx.signal.throwIfAborted();
    const workHash = semanticWorkHash(job), receipt = receipts.get(workHash);
    const raw = receipt?.findings ?? await runtime.assessScenarioProposals(job.input, ctx);
    if (serializedBytes({ findings: raw }) > SCENARIO_OUTPUT_BYTES) throw new Error('Смысловой ответ превышает допустимый объём. Частичные проверки сохранены.');
    const returned = raw.map(f => semanticFindingSchema.parse(f));
    if (returned.some(f => f.reason.length > SEMANTIC_REASON_CHARS)) throw new Error('Обоснование смысловой проверки превышает допустимую длину.');
    const expected = job.input.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path })));
    if (returned.length !== expected.length || expected.some(f => returned.filter(r => key(r) === key(f)).length !== 1)) throw new Error('Смысловой ответ не покрывает ровно запрошенные поля. Частичные проверки сохранены.');
    receipts.set(workHash, { workHash, findings: returned });
    for (const finding of returned) {
      const id = key(finding);
      const previous = results.get(id);
      if (!previous || severity[finding.status] > severity[previous.status]) results.set(id, finding);
      remaining.set(id, remaining.get(id)! - 1);
      const worst = results.get(id)!;
      findings.set(id, remaining.get(id) && worst.status === 'ready'
        ? { ...worst, status: 'needs_review', reason: 'Проверка ещё не завершила все основания и сравнения этого поля.' }
        : worst);
    }
    if (!receipt) await persist(partial());
  }
  const complete = recordSemanticAssessment({ ...library, revision }, [...findings.values()], SEMANTIC_CONTEXT_VERSION);
  complete.semanticAssessment = { ...complete.semanticAssessment!, contextVersion: SEMANTIC_CONTEXT_VERSION, complete: true, workReceipts: [...receipts.values()] };
  return complete;
}
