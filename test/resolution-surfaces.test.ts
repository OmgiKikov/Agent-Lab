import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ExperimentStore } from '../src/store.js';
import { issueRecord } from './helpers/issues.js';
import extension from '../extensions/agent-lab.ts';

test('CLI and tool expose the same dev-only bundle and native candidate registration',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'resolution-surfaces-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const store=new ExperimentStore(join(cwd,'.agent-lab'));await store.init();const source=issueRecord();await store.save(source);await store.syncIssues(source);const issue=(await store.readIssues())[0]!;await store.close();
 const tools=new Map<string,any>();extension({registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand(){},on(){}} as any);
 const tool=tools.get('agent_lab_resolution');assert.ok(tool,'Resolution tool is registered');
 const input={issueId:issue.id,sourceRunId:source.id},ctx={cwd,hasUI:true,mode:'tui',ui:{confirm:async()=>false}};
 const reply=await tool.execute('bundle',{operation:'bundle',input},new AbortController().signal,undefined,ctx);
 const bundle=JSON.parse(reply.content[0].text);assert.equal(bundle.sourceRunId,source.id);assert.deepEqual(bundle.controlTrials,[]);
 const file=join(cwd,'request.json');await writeFile(file,JSON.stringify(input));
 const cli=spawnSync(process.execPath,['dist/cli.js','resolutions','--operation','bundle','--input',file,'--data-dir',store.directory],{encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).sourceRunId,bundle.sourceRunId);assert.equal(JSON.parse(cli.stdout).devTrials.length,bundle.devTrialCount);
 const draft=JSON.parse((await tool.execute('candidate',{operation:'candidate',input:{sourceRunId:source.id,target:{kind:'sandbox'},targetVersion:'immutable-build-2'}},new AbortController().signal,undefined,ctx)).content[0].text);
 assert.equal(draft.phase,'review');assert.equal(draft.targetVersion,'immutable-build-2');assert.equal(draft.scenarioCount,source.scenarios.length);assert.equal('scenarios' in draft,false);
});

test('routine resolution tool responses stay compact with exact evidence available by page',async()=>{
 const view=await import('../src/issue-view.js');
 const trial=issueRecord().trials[0]!; trial.events=Array.from({length:500},(_,seq)=>({seq,type:'assistant' as const,text:'x'.repeat(1000)}));
 const bundle={format:'agent-lab-fix-1',issue:{id:'issue',observation:'defect',hypotheses:[]},sourceRunId:'source',targetIdentity:'x',reproducer:[],devTrials:[trial],controlTrials:[],instructions:[]};
 const compact=view.compactFixBundle(bundle);
 assert.ok(JSON.stringify(compact).length<5000);assert.equal(compact.devTrialCount,1);assert.equal(compact.devTrials.items[0]!.id,trial.id);
 const detail=view.compactFixBundle(bundle,{trialId:trial.id,offset:20,limit:2});
 assert.equal(detail.detail!.events.items.length,2);assert.equal(detail.detail!.events.items[0]!.seq,20);
});

test('native policy preparation uses readable issue variants without typing internal IDs',async t=>{
 const {ExperimentLab}=await import('../src/experiment.js'),{createDemoRuntime}=await import('../src/demo.js'),{showIssueWorkspace}=await import('../extensions/issues.ts'),{evaluatorVersion}=await import('../src/pi.js');
 const dir=await mkdtemp(join(tmpdir(),'resolution-native-'));t.after(()=>rm(dir,{recursive:true,force:true}));const lab=new ExperimentLab(dir,createDemoRuntime());await lab.init();t.after(()=>lab.close());
 const source=issueRecord();source.settings.repeats=2;source.evaluatorVersion=evaluatorVersion(source.settings);delete source.failureModes;
 const reg={...structuredClone(source.scenarios[0]!),id:'guard',familyId:'guard',title:'Сохранить корректный результат'};source.scenarios.push(reg);
 source.trials=source.scenarios.flatMap(s=>Array.from({length:2},(_,repeat)=>({...structuredClone(source.trials[0]!),id:`${s.id}_${repeat}`,scenarioId:s.id,familyId:s.familyId,repeat,outcome:s.id==='guard'?'pass' as const:'fail' as const,checks:source.trials[0]!.checks.map(c=>({...c,passed:s.id==='guard'}))})));
 await lab.store.save(source);await lab.store.syncIssues(source);await lab.registerCandidate(source.id,{target:{kind:'sandbox'},targetVersion:'candidate-v2'});
 let actions=0;const seen:string[]=[];
 const ctx={ui:{select:async(title:string,choices:string[])=>{seen.push(title+' '+choices.join(' '));if(choices.includes('Сохранить правило проверки исправления')) return actions++===0?'Сохранить правило проверки исправления':undefined;return choices[0];},input:async()=>{throw new Error('Normal issue path must not require typing IDs');},confirm:async()=>true,custom:async(factory:any)=>{const c=factory({requestRender(){},terminal:{rows:100}},{fg:(_:string,s:string)=>s},{},()=>{});seen.push(c.render(100).join('\n'));}},signal:new AbortController().signal};
 await showIssueWorkspace(ctx as any,source,lab,async()=>lab);
 assert.equal((await lab.store.readIssueJournal()).resolutions.length,1);assert.ok(seen.some(s=>s.includes('Возврат')&&s.includes('Использовать варианты проблемы')));
});
