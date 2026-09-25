#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ExperimentLab } from '../dist/experiment.js';
import { fingerprint, isCardExecution } from '../dist/contracts.js';
import { customerBrief } from '../dist/card-customer.js';
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, run: { type: 'string' }, output: { type: 'string' }, subject: { type: 'string', default: 'agent' } } });
if (!values['data-dir'] || !values.run || !values.output) throw new Error('Usage: node scripts/export-blind-review.mjs --data-dir PATH --run ID --output NEW_DIRECTORY');
if (!['agent', 'customer'].includes(values.subject)) throw new Error('--subject must be agent or customer');
const record = await new ExperimentLab(resolve(values['data-dir'])).get(values.run);
const candidates = record.trials.flatMap(trial => {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  if (!scenario || !isCardExecution(scenario.execution)) return [];
  const customer = values.subject === 'customer';
  const expectations = customer ? [{ id: 'user_fidelity', text: 'Соблюдал ли синтетический клиент факты, роль, поворот и условие ухода в своём задании?', requirementIds: [] }] : scenario.execution.evaluatorView.expectations;
  return expectations.flatMap(expectation => {
    const assessment = trial.assessments?.find(a => a.metricId === expectation.id);
    if (!assessment) return [];
    const rules = scenario.execution.evaluatorView.requirements.filter(rule => expectation.requirementIds.includes(rule.id));
    const card = record.librarySnapshot?.cards.find(c => c.id === scenario.id);
    const original = customer && card?.origin.kind === 'dialogue' ? record.dialogues.find(d => d.id === card.origin.dialogueId) : undefined;
    const input = { ...(customer ? { brief: customerBrief(scenario.execution.userView), originalMessages: original?.messages ?? [] } : {}), title: scenario.title, request: scenario.user.opening, expectation, rules,
      events: trial.events.filter(event => ['user', 'assistant', 'tool_call', 'tool_result', 'observation', ...(customer ? ['simulator'] : [])].includes(event.type)).map(event => event.type === 'simulator' ? { seq: event.seq, type: 'simulator', result: { move: event.result?.move, message: event.result?.message } } : event) };
    return [{ id: fingerprint({ runId: record.id, trialId: trial.id, metric: expectation.id }).slice(0, 16), input,
      inputHash: fingerprint(input), target: { trialId: trial.id, metricId: expectation.id }, modelResult: assessment.result }];
  });
});
const selected = [], seen = new Set();
for (const outcome of ['pass', 'fail', 'unknown']) {
  for (const candidate of candidates.filter(c => c.modelResult === outcome).sort((a,b) => a.id.localeCompare(b.id))) {
    if (selected.filter(c => c.modelResult === outcome).length >= 3) break;
    if (seen.has(candidate.target.trialId)) continue;
    selected.push(candidate); seen.add(candidate.target.trialId);
  }
}
selected.sort((a,b) => a.id.localeCompare(b.id));
if (!selected.length) throw new Error('No assessed card expectations to review');
const publicPacket = { protocol: 'blind-review-1', subject: values.subject, runId: record.id, sourceHash: fingerprint(record), createdAt: new Date().toISOString(),
  cases: selected.map(({ id, input, inputHash }) => ({ id, inputHash, ...input })) };
const directory = resolve(values.output);
process.umask(0o077); await mkdir(directory, { recursive: false });
await writeFile(join(directory, 'private-key.json'), JSON.stringify({ packetHash: fingerprint(publicPacket), targets: selected.map(({ id, inputHash, target, modelResult }) => ({ id, inputHash, target, modelResult })) }, null, 2));
const json = JSON.stringify(publicPacket).replaceAll('<', '\\u003c');
const html = String.raw`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Lab · Независимая оценка</title>
<style>body{background:#101719;color:#e8efed;font:16px/1.6 system-ui;margin:0}main{max-width:960px;margin:48px auto;padding:0 24px}h1{font-size:32px;line-height:1.2}h2{font-size:22px}small,.muted{color:#a3b5b1}.tag{color:#86d6bd;font:12px monospace;letter-spacing:2px}article{border:1px solid #354b45;border-radius:16px;padding:28px;margin:28px 0}blockquote{border-left:3px solid #74c5ae;padding:12px 18px;margin:12px 0;background:#192622;white-space:pre-wrap}.message{margin:18px 0;white-space:pre-wrap}.agent{border-left:2px solid #74c5ae;padding-left:18px}.tools{font:13px monospace;white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:10px 0;cursor:pointer}textarea{width:100%;box-sizing:border-box;background:#16211e;border:1px solid #456258;color:#fff;padding:12px;border-radius:8px;font:inherit}button{background:#91dec4;border:0;color:#10231c;padding:14px 22px;border-radius:10px;font:600 16px system-ui;cursor:pointer}footer{position:sticky;bottom:0;padding:18px;background:#101719ee;border-top:1px solid #354b45}summary{cursor:pointer;color:#a3b5b1}a{color:#91dec4}</style>
<main><div class="tag">AGENT LAB / ПРОВЕРКА СУДЬИ</div><h1>Сначала ваша оценка.<br>Затем сравнение с моделью.</h1>
<p>В каждом примере оцените только указанное ожидание по разговору и правилу. Оценки судьи скрыты. Если данных или правила недостаточно, выберите «Нельзя оценить»; ошибки самой карточки тоже можно отметить.</p>
<p class="muted">Это целевая выборка для поиска расхождений, а не замер точности на всём трафике. Ответы сохраняются только в этом браузере. Кнопка внизу скачает JSON для сверки.</p><div id="cases"></div><footer><button id="download">Скачать мои оценки</button> <small id="status"></small></footer></main>
<script>const packet=${json}; const key='agent-lab-blind-'+packet.sourceHash; let answers={};try{answers=JSON.parse(localStorage.getItem(key)||'{}')}catch{};
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el};
function update(){document.getElementById('status').textContent=packet.cases.filter(c=>answers[c.id]?.verdict).length+' / '+packet.cases.length+' оценено';try{localStorage.setItem(key,JSON.stringify(answers))}catch{}}
packet.cases.forEach((item,i)=>{const a=node('article');a.append(node('small','ПРИМЕР '+(i+1)),node('h2',item.title),node('strong','Что проверяем'),node('blockquote',item.expectation.text+(item.expectation.appliesWhen?'\nПрименяется, когда: '+item.expectation.appliesWhen:'')));
if(item.brief){a.append(node('strong','Задание клиента'),node('blockquote',JSON.stringify(item.brief,null,2)));const d=node('details');d.append(node('summary','Исходный разговор из логов — для отдельной оценки реализма'),node('div',JSON.stringify(item.originalMessages,null,2),'tools'));a.append(d)}
for(const rule of item.rules)a.append(node('small','Основание'),node('blockquote',rule.quote));
for(const event of item.events){if(event.type==='user'||event.type==='assistant'){const m=node('div',undefined,'message '+(event.type==='assistant'?'agent':''));m.append(node('small',event.type==='user'?'КЛИЕНТ':'АГЕНТ'),node('div',event.text||''));a.append(m)}else{const d=node('details');d.append(node('summary',event.type+' · '+(event.tool||'наблюдение')),node('div',JSON.stringify(event.result??event.args??event.state,null,2),'tools'));a.append(d)}}
a.append(node('strong',item.brief?'Соблюдение задания клиентом':'Ваш вердикт'));
for(const [value,title] of [['pass','Выполнено'],['fail','Нарушено'],['unknown','Нельзя оценить по этим данным'],['invalid','Ошибка в карточке или правиле']]){const label=node('label'),input=node('input');input.type='radio';input.name=item.id;input.value=value;input.checked=answers[item.id]?.verdict===value;input.onchange=()=>{answers[item.id]={...answers[item.id],verdict:value,at:new Date().toISOString()};update()};label.append(input,node('span',' '+title));a.append(label)}
if(item.brief){a.append(node('strong','Отдельно: реалистичность поведения'),node('small','Сравните с исходным разговором: уточнения, настойчивость, длина и естественность реплик. Реалистичность и соблюдение задания — разные вопросы.'));for(const [value,title] of [['plausible','Поведение правдоподобно'],['implausible','Поведение не похоже на реального клиента'],['unknown','Недостаточно данных']]){const label=node('label'),input=node('input');input.type='radio';input.name=item.id+'-realism';input.checked=answers[item.id]?.realism===value;input.onchange=()=>{answers[item.id]={...answers[item.id],realism:value};update()};label.append(input,node('span',' '+title));a.append(label)}}
const note=node('textarea');note.rows=3;note.placeholder='Какая реплика или правило подтверждает вашу оценку?';note.value=answers[item.id]?.note||'';note.oninput=()=>{answers[item.id]={...answers[item.id],note:note.value};update()};a.append(note);document.getElementById('cases').append(a)});update();
document.getElementById('download').onclick=()=>{const pending=packet.cases.some(c=>!answers[c.id]?.verdict||!answers[c.id]?.note?.trim()||(c.brief&&!answers[c.id]?.realism));if(pending){document.getElementById('status').textContent='Для каждого примера выберите вердикт и укажите основание.';return}const out={protocol:packet.protocol,runId:packet.runId,sourceHash:packet.sourceHash,exportedAt:new Date().toISOString(),reviews:packet.cases.map(c=>({id:c.id,inputHash:c.inputHash,...answers[c.id]}))};const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));const a=node('a');a.href=url;a.download='agent-lab-independent-labels.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
</script></html>`;
await writeFile(join(directory, 'review.html'), html); await writeFile(join(directory, 'packet.json'), JSON.stringify(publicPacket, null, 2));
console.log(JSON.stringify({ examples: selected.length, review: join(directory, 'review.html'), hiddenVerdicts: true }));
