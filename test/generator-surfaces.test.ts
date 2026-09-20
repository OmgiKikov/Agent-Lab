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
 await writeFile(input,JSON.stringify({candidates:[{id:'bad',contentHash:'x',quality:'blocked',provenanceErrors:0,applicabilityErrors:0,validity:'invalid',duplicate:'none',coverage:['new'],unmetConditions:1,reproducibleIssues:9,instability:1,targetFailures:999}],history:[]}));
 const result=await exec(process.execPath,[resolve('dist/cli.js'),'generator','--operation','select','--input',input,'--data-dir',join(dir,'data')]);
 const parsed=JSON.parse(result.stdout);assert.deepEqual(parsed.selected,[]);assert.equal(parsed.excluded[0].id,'bad');
});
