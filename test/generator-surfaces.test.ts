import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const exec=promisify(execFile);
test('CLI generator selection is read only and gates an invalid high failure variant',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'generator-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const input=join(dir,'select.json');
 await writeFile(input,JSON.stringify({candidates:[{id:'bad',contentHash:'a'.repeat(64),quality:'blocked',provenanceErrors:0,applicabilityErrors:0,validity:'invalid',duplicate:'none',coverage:['new'],unmetConditions:1,reproducibleIssues:9,instability:1,targetFailures:999}],history:[]}));
 const result=await exec(process.execPath,[resolve('dist/cli.js'),'generator','--operation','select','--input',input,'--data-dir',join(dir,'data')]);
 const parsed=JSON.parse(result.stdout);assert.deepEqual(parsed.selected,[]);assert.equal(parsed.excluded[0].id,'bad');
});

test('CLI selection rejects incomplete correctness evidence and null history before returning a ranking',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'generator-cli-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const ready={id:'candidate',contentHash:'a'.repeat(64),quality:'ready',provenanceErrors:0,applicabilityErrors:0,validity:'valid',duplicate:'none',coverage:['new'],unmetConditions:1,reproducibleIssues:0,instability:0};
 for(const [index,input,field] of [[0,{candidates:[{...ready,provenanceErrors:undefined}],history:[]},'provenanceErrors'],[1,{candidates:[{...ready,applicabilityErrors:null}],history:[]},'applicabilityErrors'],[2,{candidates:[ready],history:null},'history']] as const){
  const file=join(dir,`${index}.json`);await writeFile(file,JSON.stringify(input));
  await assert.rejects(exec(process.execPath,[resolve('dist/cli.js'),'generator','--operation','select','--input',file,'--data-dir',join(dir,'data')]),error=>{assert.match(error.stderr,new RegExp(field));assert.doesNotMatch(error.stdout,/"selected"/);return true;});
 }
});
