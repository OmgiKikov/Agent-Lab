// Review reproductions: synthetic fixtures and local targets only; no model calls.
// Run from the repository: node --import tsx docs/reviews/2026-09-25/reproduce.mjs
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const { evaluateTrial } = await import(`${root}/src/evaluation.ts`);
const { briefCard, requirements } = await import(`${root}/test/helpers/cards.ts`);
const { compileCard } = await import(`${root}/src/card/compile.ts`);
const { settingsSchema } = await import(`${root}/src/contracts.ts`);
const { automaticTrialResult } = await import(`${root}/src/outcomes.ts`);
const { ExperimentStore } = await import(`${root}/src/store.ts`);
const directory = await mkdtemp(join(tmpdir(), 'lab-architecture-repro-'));
const targetPath = join(directory, 'target.mjs');
await writeFile(targetPath, `export function createSession() { return { async respond() { return {reply:'Возврат оформлен.', records:{order:{status:'done'}}, resetConfirmed:true, eventsComplete:true}; }, async close() {} }; }`);
const revision = {id:'test_revision',spec:{name:'Test',instructions:'Test',tools:[]},createdAt:new Date().toISOString(),label:'Test'};
const ctx = () => ({signal:new AbortController().signal,timeoutMs:5000,beforeCall(){},addUsage(){}});
const assess = async ({scenario,trial}) => (scenario.metrics ?? []).map(m => ({metricId:m.id,result:'pass',evidence:[trial.events.findLast(e=>e.state !== undefined)?.seq ?? trial.events.find(e=>e.type==='assistant').seq],rationale:'Deterministic test vote'}));
async function trial(card,runtime) {
 const scenario=compileCard(card,{requirements,maxTurns:2});
 const run=await evaluateTrial({runtime:{assess,...runtime},revision,scenario,repeat:0,manifestHash:'test',sources:[],requirements,settings:settingsSchema.parse({maxTurns:2,repeats:1}),ctx:ctx(),userMode:'reactive',target:{kind:'module',path:targetPath,exportName:'createSession'}});
 return {scenario,run};
}
try {
 const first=await trial(briefCard(),{speakAsCustomer:async()=>({move:'clarify',message:'Поясните, пожалуйста.'})});
 console.log(JSON.stringify({case:'required turn never delivered',outcome:first.run.outcome,invalidCause:first.run.invalidCause,automaticResult:automaticTrialResult(first.scenario,first.run),requiredTurn:first.scenario.execution.userView.policy.actions.find(a=>a.id==='turn').payload,userMessages:first.run.events.filter(e=>e.type==='user').map(e=>e.text),simulatorChecks:first.run.simulatorChecks,assessmentError:first.run.assessmentError}));
 const card=briefCard({turn:null,agentMust:[{id:'e1',text:'изменить состояние заказа',requirementIds:['refund_rule'],observation:'state'}]});
 for(const mode of ['controlled','free']) {
  const runtime=mode==='free'?{speakAsCustomer:async()=>({move:'leave',message:''})}:{selectUserAction:async()=>({actionId:'leave'})};
  const result=await trial(card,runtime);
  console.log(JSON.stringify({case:'state evidence',mode,observationEvents:result.run.events.filter(e=>e.type==='observation').length,finalState:result.run.finalState,automaticResult:automaticTrialResult(result.scenario,result.run),assessments:result.run.assessments,assessmentError:result.run.assessmentError}));
 }
 const { loggedRun, calibrated } = await import(`${root}/test/helpers/calibration.ts`);
 const { buildResultView } = await import(`${root}/src/result-view.ts`);
 const logged = loggedRun(1, () => ({e1:'pass', e2:'fail'}));
 const record = calibrated(logged, () => ['pass','pass']);
 const synthetic = record.trials[0];
 const action = record.scenarios[0].execution.userView.policy.actions.find(a => a.kind === 'answer');
 synthetic.events.find(e => e.type === 'simulator').result = {decision:{actionId:action.id},accepted:true};
 synthetic.events.push({seq:3,type:'user',text:'Номер терминала: 5000'}, {seq:4,type:'assistant',text:'Понял.'}, {seq:5,type:'simulator',result:{decision:{actionId:'leave'},accepted:true}});
 const paths = () => buildResultView(record).calibration.disagreements.map(d => ({path:d.path,hint:d.hint}));
 console.log(JSON.stringify({case:'calibration paths',mode:'controlled',disagreements:paths()}));
 for (const event of synthetic.events) if (event.type === 'simulator') event.result = {protocol:'card-customer-free-v1',move:event.seq === 5 ? 'leave':'answer',message:event.seq === 5 ? '':'Номер терминала: 5000'};
 console.log(JSON.stringify({case:'calibration paths',mode:'free',disagreements:paths()}));
 const storeDir=join(directory,'store'); await mkdir(join(storeDir,'publications'),{recursive:true});
 await writeFile(join(storeDir,'.lock'),JSON.stringify({pid:2147483647,token:'stale'}));
 await writeFile(join(storeDir,'publications','broken.json'),'{');
 const store = new ExperimentStore(storeDir);
 try {await store.init();}catch(error){console.log(JSON.stringify({case:'failed stale-lock recovery',error:error.message,lockAfterFailure:JSON.parse(await readFile(join(storeDir,'.lock'),'utf8'))}));}
 await rm(join(storeDir,'publications','broken.json'));
 const second = new ExperimentStore(storeDir);
 try {await second.init();console.log('retry succeeded');}catch(error){console.log(JSON.stringify({case:'retry after publication repaired',error:error.message}));}
 await second.close();await store.close();
} finally {await rm(directory,{recursive:true,force:true});}
