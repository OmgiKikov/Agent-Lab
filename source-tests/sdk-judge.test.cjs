const assert=require('node:assert/strict');
const sdk=require('../langwatch/.local/app/platform/app/node_modules/@langwatch/scenario');
const criteria=['Проверка правильного русского критерия первого обязательства агента в деловой ситуации клиента.','Проверка второго русского критерия который требует обязательных доказательств внутреннего действия.'];
const judge=sdk.judgeAgent({criteria,model:{}});
const result=judge.parseToolCalls({toolCalls:[{toolName:'finish_test',input:{verdict:'success',criteria:{criterion_1:'inconclusive',criterion_0:'true'},reasoning:'Synthetic evidence fixture'}}]},criteria,{verdictForced:true});
assert.equal(result.verdict,'inconclusive');assert.equal(result.success,false);assert.deepEqual(result.unmetCriteria,[]);assert.deepEqual(result.metCriteria,[criteria[0]]);assert.deepEqual(result.inconclusiveCriteria,[criteria[1]]);
console.log('PASS actual installed SDK judge: separate Cyrillic checks, shuffled keys and UNKNOWN survives a claimed success');
