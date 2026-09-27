import { createHash, randomUUID } from 'node:crypto';
import type { Analysis } from './schema';

export interface NativeBatch {
  id: string;
  at: string;
  agentId: string;
  repeatCount: number;
  planned: number;
  status: 'preparing' | 'dispatching' | 'queued' | 'partial' | 'dispatch_unknown' | 'failed';
  suiteId?: string;
  nativeBatchId?: string;
  judgeModel: string;
  simulatorModel: string;
  cards: { cardId: string; scenarioId: string; definitionHash: string }[];
  items: { cardId: string; scenarioId: string; id: string }[];
  error?: string;
}
export interface NativeWorkflow {
  save(job: Analysis): Promise<unknown>;
  api(url: string, body?: unknown): Promise<any>;
  models(): Promise<{ judgeModel: string; simulatorModel: string }>;
  configureSuite?(id: string, models: { judgeModel: string; simulatorModel: string }): Promise<unknown>;
}
const active = new Set(['IN_PROGRESS','PENDING','QUEUED']);
const finished = new Set(['SUCCESS','FAILED','ERROR','CANCELLED','STALLED','SKIPPED']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Serializes all mutations of one analysis, not one card: the record is saved whole. */
export class KeyedSerial {
  private locks = new Map<string, Promise<unknown>>();
  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    this.locks.set(id, work);
    try { return await work; }
    finally { if (this.locks.get(id) === work) this.locks.delete(id); }
  }
}

/** Run the accepted situations together using LangWatch's own suite and queue. Caller holds the analysis lock. */
export async function scheduleBatch(job: Analysis, agentId: string, repeats: number, note: string, deps: NativeWorkflow): Promise<NativeBatch> {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Число повторов: от 1 до 10.');
  if (['planning','judging'].includes(job.status)) throw new Error('Подготовка ещё идёт.');
  job.batches ??= [];
  const previous = job.batches.at(-1);
  assertDispatchKnown(job);
  if (previous?.items.length) {
    const states = await Promise.all(previous.items.map(async item => {
      try { return await deps.api('/api/simulation-runs/' + item.id); }
      catch { return { status: 'QUEUED' }; }
    }));
    if (states.some(state => !finished.has(state.status))) return previous;
  }
  const cards = job.cards.filter(card => card.status === 'saved' && card.scenarioId);
  if (!cards.length) throw new Error('Нет готовых ситуаций. Причины сохранены в разборе.');
  // Older single-card launches also hold the batch until they finish.
  const lastRuns = cards.flatMap(card => card.runs.at(-1) ? [card.runs.at(-1)!] : []);
  for (const run of lastRuns) {
    const state = await deps.api('/api/simulation-runs/' + run.id);
    if (!finished.has(state.status)) throw new Error('Ещё идёт предыдущая проверка. Дождитесь результата.');
  }
  const agents = await deps.api('/api/agents');
  if (!(agents.data ?? agents).some((agent: any) => agent.id === agentId && agent.type === 'http')) throw new Error('Подключённый HTTP агент не найден.');
  const models = await deps.models();
  const definitions = await Promise.all(cards.map(async card => {
    const scenario = await deps.api('/api/scenarios/' + card.scenarioId);
    return {cardId: card.id,scenarioId: card.scenarioId!,definitionHash: digest({situation:scenario.situation,criteria:scenario.criteria})};
  }));
  const batch: NativeBatch = {id:randomUUID(),at:new Date().toISOString(),agentId,repeatCount:repeats,planned:cards.length*repeats,
    status:'preparing',...models,cards:definitions,items:[]};
  job.batches.push(batch);
  await deps.save(job);
  try {
    const suite = await deps.api('/api/suites',{name:'Проверка · '+job.task.slice(0,75)+' · '+batch.id.slice(0,8),scenarioIds:definitions.map(d=>d.scenarioId),
      targets:[{type:'http',referenceId:agentId}],repeatCount:repeats});
    batch.suiteId=suite.id;
    await deps.configureSuite?.(suite.id,models);
    batch.status='dispatching';
    await deps.save(job); // Persist intent before enqueue: a crash here cannot silently replay the calls.
    const started = await deps.api('/api/suites/'+suite.id+'/run',{note:note||'Проверка по реальным обращениям',idempotencyKey:batch.id});
    batch.nativeBatchId=started.batchRunId;
    const seen = new Set<string>();
    batch.items=(started.items??[]).flatMap((item:any)=>{
      const definition=definitions.find(d=>d.scenarioId===item.scenarioId);
      if (!definition || typeof item.scenarioRunId!=='string' || seen.has(item.scenarioRunId)) return [];
      seen.add(item.scenarioRunId);
      const card=cards.find(c=>c.id===definition.cardId)!;
      card.runs.push({id:item.scenarioRunId,agentId,definitionHash:definition.definitionHash,at:batch.at,...models,note,batchId:batch.id});
      return [{id:item.scenarioRunId,cardId:card.id,scenarioId:item.scenarioId}];
    });
    batch.status=batch.items.length===batch.planned?'queued':'partial';
    if (batch.status==='partial') batch.error=`LangWatch поставил в очередь ${batch.items.length} из ${batch.planned} попыток. Остальные не измерены.`;
    await deps.save(job);
    return batch;
  } catch(error) {
    batch.status=batch.status==='dispatching'?'dispatch_unknown':'failed';
    batch.error=error instanceof Error?error.message:String(error);
    await deps.save(job);
    throw error;
  }
}

/** A denominator belongs to the frozen batch, including attempts LangWatch could not schedule. */
export function batchSummary(batch: NativeBatch, states: {id:string;status:string}[]) {
  const byId = new Map(states.map(state=>[state.id,state.status]));
  const count = (status: string) => batch.items.filter(item=>byId.get(item.id)===status).length;
  const passed=count('SUCCESS'),failed=count('FAILED');
  const pending=batch.items.filter(item=>active.has(byId.get(item.id)??'QUEUED')).length;
  const errors=batch.items.filter(item=>['ERROR','STALLED','CANCELLED','SKIPPED'].includes(byId.get(item.id)??'')).length;
  const missing=Math.max(0,batch.planned-batch.items.length);
  const uncertain=["dispatching","dispatch_unknown"].includes(batch.status);
  const notScheduled=uncertain?0:missing;
  const schedulingUnknown=uncertain?missing:0;
  return {planned:batch.planned,scheduled:batch.items.length,passed,failed,measured:passed+failed,pending,errors,notScheduled,schedulingUnknown,
    successRate:passed+failed===batch.planned&&batch.planned>0?passed/batch.planned:null};
}

/** A per-card retry must not bypass a batch whose enqueue outcome is unknown. */
export function assertDispatchKnown(job: Pick<Analysis, 'batches'>): void {
  if (job.batches?.some(batch => ['dispatching','dispatch_unknown'].includes(batch.status))) {
    throw new Error('Результат отправки неизвестен. Сверьте запуск в LangWatch Simulations; повторная отправка может создать платные дубликаты.');
  }
}
