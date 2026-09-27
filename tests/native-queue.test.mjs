import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Exercise the installed native method, not a mocked REST response. Infrastructure imports are stubbed;
// the real scheduling method receives a queue which rejects one request, as Redis can in production.
test('installed LangWatch refuses to claim a complete receipt after a queue error', async () => {
  let source=await readFile(new URL('../langwatch/.local/app/platform/app/src/server/app-layer/suites/suite-run.service.ts',import.meta.url),'utf8');
  source=stripTypeScriptTypes(source,{mode:'transform'}).replace(/^import[\s\S]*?;\n/gm,'').replace(/export /g,'');
  const context=vm.createContext({generate:()=>({toString:()=>Math.random().toString()}),createLogger:()=>({debug(){}}),generateBatchRunId:()=> 'batch',getSuiteSetId:id=>id,withNote:()=>({}),KSUID_RESOURCES:{SCENARIO_RUN:'run'},Date,Promise,Map,Set});
  vm.runInContext(source+'\nthis.Subject=SuiteRunService;',context);
  const service=new context.Subject({},async()=>{},async data=>{if(data.scenarioId==='rejected')throw new Error('queue refused');});
  await assert.rejects(()=>service.startRun({suiteId:'suite',projectId:'p',activeScenarioIds:['accepted','rejected'],scenarioNameMap:new Map(),scenarioVersionMap:new Map(),activeTargets:[{type:'http',referenceId:'agent'}],repeatCount:1,skippedArchived:{scenarios:[],targets:[]},idempotencyKey:'request'}), /outcome uncertain/);
});
