import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages, evidenceSources, criterionText } from '../langwatch-custom/src/server/agent-lab/evidence.ts';
import { scheduleBatch, batchSummary, KeyedSerial } from '../langwatch-custom/src/server/agent-lab/workflow.ts';

const rule = { id: 'r', text: 'Дать инструкцию', condition: 'Клиент просит возврат', acceptable: 'Уточнить номер', observation: 'reply', sourceId: 'exact', quote: 'Возврат занимает два дня.', approved: true };
const card = (id: string) => ({ id, name: id, status: 'saved', scenarioId: 's-' + id, origin: 'coverage', criteria: ['Правило'], situation: 'Хочу вернуть деньги', ruleIds: ['r'], definitionHash: 'h', runs: [] });
function fixture() {
  const job: any = { id: 'j', projectId: 'p', task: 'Возвраты', status: 'done', cards: [card('a'), card('b')], batches: [] };
  const calls: any[] = [];
  const saved: any[] = [];
  const deps: any = {
    save: async () => saved.push(structuredClone(job)),
    models: async () => ({ judgeModel: 'judge', simulatorModel: 'client' }),
    api: async (url: string, body?: any) => {
      calls.push({ url, body });
      if (url === '/api/agents') return [{ id: 'agent', type: 'http' }];
      if (url.startsWith('/api/scenarios/')) return { situation: 'Хочу вернуть деньги', criteria: ['Правило'] };
      if (url === '/api/suites') return { id: 'suite' };
      if (url.endsWith('/run')) return { batchRunId: 'batch', items: ['a','b'].flatMap(id => [0,1].map(n => ({ scenarioId: 's-'+id, scenarioRunId: id+n }))) };
      return { status: 'IN_PROGRESS' };
    },
  };
  return { job, calls, saved, deps };
}
test('words CLIENT and AGENT inside a reply do not create speakers', () => {
  const turns = messages('CLIENT: Что такое AGENT?\nAGENT: Это название; CLIENT — клиент.');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].content, 'Что такое AGENT?');
});
test('JSON role messages can be imported without marker strings', () => {
  assert.equal(messages(JSON.stringify([{role:'user',content:'Привет'},{role:'assistant',content:'Здравствуйте'}])).length, 2);
});
test('judge receives full cited sources even outside keyword top results', () => {
  const sources: any[] = [...Array.from({length:10},(_,i)=>({id:'other'+i,name:'тариф',content:'тариф',kind:'knowledge'})),{id:'exact',name:'Возврат',content:'Начало. '+rule.quote+' Исключения.',kind:'knowledge'}];
  const read = evidenceSources(sources, 'тариф', [rule] as any);
  assert.equal(read.find(s=>s.id==='exact')?.content, sources.at(-1)?.content);
  assert.ok(criterionText(rule as any, sources).includes(rule.quote));
});
test('all cards and repeats are dispatched as one native suite', async () => {
  const f=fixture(); await scheduleBatch(f.job,'agent',2,'проверка',f.deps);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/run')).length,1);
  assert.equal(f.calls.find(c=>c.url==='/api/suites').body.repeatCount,2);
  assert.deepEqual(f.calls.find(c=>c.url==='/api/suites').body.scenarioIds,['s-a','s-b']);
  assert.equal(f.job.cards[0].runs.length,2);
  assert.equal(f.job.batches[0].planned,4);
  assert.ok(f.saved.some(j=>j.batches[0]?.status==='dispatching'));
});
test('an active batch prevents another paid dispatch', async () => {
  const f=fixture(); await scheduleBatch(f.job,'agent',2,'',f.deps); await scheduleBatch(f.job,'agent',2,'',f.deps);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/run')).length,1);
});
test('ambiguous enqueue is persisted and not blindly retried', async () => {
  const f=fixture();const api=f.deps.api;f.deps.api=async(u:string,b:any)=>{if(u.endsWith('/run'))throw new Error('timeout');return api(u,b);};
  await assert.rejects(()=>scheduleBatch(f.job,'agent',2,'',f.deps),/timeout/);
  assert.equal(f.job.batches[0].status,'dispatch_unknown');
  await assert.rejects(()=>scheduleBatch(f.job,'agent',2,'',f.deps),/LangWatch|неизвест|свер/i);
});
test('partial enqueue is not counted as complete coverage', async () => {
  const f=fixture();const api=f.deps.api;f.deps.api=async(u:string,b:any)=>u.endsWith('/run')?{batchRunId:'batch',items:[{scenarioId:'s-a',scenarioRunId:'a0'}]}:api(u,b);
  const batch=await scheduleBatch(f.job,'agent',2,'',f.deps);
  const result=batchSummary(batch,[{id:'a0',status:'SUCCESS'}]);
  assert.equal(result.planned,4);assert.equal(result.notScheduled,3);assert.equal(result.passed,1);assert.equal(result.measured,1);
  assert.equal(result.successRate,null);
});
test('one analysis serializes read-modify-write actions', async () => {
  const serial=new KeyedSerial();let n=0;
  await Promise.all([1,2,3].map(()=>serial.run('job',async()=>{const before=n;await new Promise(r=>setTimeout(r,5));n=before+1;})));
  assert.equal(n,3);
});

test('inline bank export with colon still contains two distinct speakers', () => {
  const turns=messages('CLIENT: Где возврат? AGENT: Деньги поступят завтра.');
  assert.equal(turns.length,2);assert.equal(turns[1].role,'assistant');
  assert.equal(turns[0].content,'Где возврат?');
});

test('background analysis remains observed until dispatch receipt is saved', async () => {
  const { analysisNeedsRefresh } = await import('../langwatch-custom/src/server/agent-lab/progress.ts');
  assert.equal(analysisNeedsRefresh({status:'done',agentId:'agent',batches:[{status:'preparing'}]} as any),true);
  assert.equal(analysisNeedsRefresh({status:'done',agentId:'agent',batches:[{status:'dispatching'}]} as any),true);
  assert.equal(analysisNeedsRefresh({status:'done',agentId:'agent',batches:[{status:'queued'}]} as any),false);
});

test('single-card and batch retries share the same ambiguous dispatch guard', async () => {
  const { assertDispatchKnown } = await import('../langwatch-custom/src/server/agent-lab/workflow.ts');
  assert.throws(()=>assertDispatchKnown({batches:[{status:'dispatch_unknown'}]} as any),/неизвест|свер/i);
});

test('unknown scheduling is not reported as definitely unqueued', () => {
  const summary=batchSummary({planned:2,items:[],status:'dispatch_unknown'} as any,[]);
  assert.equal(summary.notScheduled,0);assert.equal(summary.schedulingUnknown,2);assert.equal(summary.successRate,null);
});
