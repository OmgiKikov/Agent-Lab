import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {proposals,rawDialogues,sources,requirements} from './helpers/scenario-library.js';
import {ExperimentLab} from '../src/experiment.js';
import {createInputSchema} from '../src/contracts.js';
import {createDemoRuntime} from '../src/demo.js';
import {importBatch} from '../src/scenario-library.js';
const config={instructions:'Не включайте пересказ агента в исходные знания.',temperature:0};
const ctx={signal:new AbortController().signal,timeoutMs:1000,beforeCall(){},addUsage(){}};
test('production benchmark retains real proposals and library rejection even when evaluator says valid',async()=>{
 const mod=await import('../src/generator-production.js').catch(()=>assert.fail('Production generator benchmark seam required'));
 let generationInput:any;
 const runtime={...createDemoRuntime(),async scenarioProposals(input){generationInput=input;const result=proposals(input.batchId).slice(1);result[0].business.requirementIds=['owner_rule']; result[0].variant.sourceDialogues[0].dialogueId='case'; const fact=result[0].variant.userState.facts[0]; fact.availability='initial';fact.origin.dialogueId='case';fact.origin.eventIndex=1;fact.origin.quote='Возврат займёт три дня';result[0].variant.evaluationSpec.checkpoints[0].requirementId='owner_rule';return result;},async assessScenarioProposals(input){return input.fields.flatMap(f=>f.paths.map(path=>({variantId:f.variantId,path,status:'ready',reason:'Проверено'})));},async assessGeneratedCase(){return {facts:[{id:'duration',availability:'initial'}],applicability:'applicable',duplicate:'none',validity:'valid',rationale:'Ошибочный оптимизм'};}};
 const result=await mod.generateProductionCase(runtime,{source:'Уточните номер терминала',ownerRequirement:'Уточните номер терминала',dialogue:rawDialogues[1].messages,factCandidates:[{id:'duration',statement:'три дня'}],proposedVariant:{condition:'Когда будет возврат?',operation:'preserve'},comparisonVariants:[]},config,ctx);
 assert.deepEqual(generationInput.generatorConfig,config);assert.ok(result.production.rawProposals.length);assert.ok(result.production.library);assert.ok(result.production.issues.some(i=>i.code==='agent_fact_as_initial'));
 assert.equal(result.output.facts[0].availability,'initial');assert.notEqual(result.output.validity,'valid');
});
test('normal new-library preparation saves and propagates generator config without changing target instructions',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'generator-prep-'));const seen:any[]=[];
 const runtime={...createDemoRuntime(),async prepare(){return {requirements:requirements.map(r=>({...r,sourceId:'source-1'})),questions:[],agent:{name:'Агент',instructions:'Неизменный промпт агента',tools:[]},scenarios:[]};},async scenarioProposals(input){seen.push(input);return proposals(input.batchId).filter(p=>input.dialogues.some(d=>d.id===p.variant.sourceDialogues[0].dialogueId));},async assessScenarioProposals(input){return input.fields.flatMap(f=>f.paths.map(path=>({variantId:f.variantId,path,status:'ready',reason:'Проверено'})));}};
 const lab=new ExperimentLab(directory,runtime as any);await lab.init();t.after(async()=>{await lab.close();await rm(directory,{recursive:true,force:true});});
 const parsed=createInputSchema.safeParse({task:'Проверить возвраты',mode:'demo',materials:sources.map(({name,content})=>({name,content})),dialogues:rawDialogues,originalImport:importBatch(rawDialogues),generatorConfig:config,scenarioCount:0});assert.equal(parsed.success,true,'CreateInput accepts a separate generator config');
 const record=await lab.create(parsed.data!);await lab.waitForIdle();const saved=await lab.get(record.id);
 assert.ok(seen.length);assert.deepEqual(seen[0].generatorConfig,config);assert.deepEqual(saved.generatorConfig,config);assert.ok(saved.generatorIdentity.configHash);assert.equal(saved.generatorIdentity.protocol,'chronological-scenarios-v1');assert.equal(saved.revisions[0].spec.instructions,'Неизменный промпт агента');
});

test('generator configuration cannot silently enter a preparation flow that does not consume it',()=>{
 const input={task:'Новая проверка',mode:'demo',materials:[{name:'Правило',content:'Уточните запрос'}],confirmedHypothesis:'Проверить подтверждённую гипотезу',scenarioCount:1,goalObservation:'reply'};
 assert.equal(createInputSchema.safeParse(input).success,true);
 const parsed=createInputSchema.safeParse({...input,generatorConfig:config});assert.equal(parsed.success,false);
 assert.ok(parsed.error?.issues.some(issue=>issue.path[0]==='generatorConfig'));
});
