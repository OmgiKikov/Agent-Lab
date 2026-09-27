const $ = (id) => document.getElementById(id);
const API = '/api/local-review';
let upload = null, reference = '', job = null, active = null, poll = null, runPoll = null, initial = true;
async function api(path, body) {
  const response = await fetch(API + path, {method:body ? 'POST':'GET', credentials:'include',
    headers:body ? {'Content-Type':'application/json'}:{}, body:body ? JSON.stringify(body):undefined});
  const data = await response.json();
  if (!response.ok) { if(response.status===401) $('auth').hidden=false; throw new Error(data.error || 'Запрос не выполнен'); }
  return data;
}
function notice(text) { $('notice').textContent=text; $('notice').hidden=!text; }
function element(tag,text,cls) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(cls) node.className=cls; return node; }
function titleOf(finding){return finding.title.replace(` [${finding.id.slice(0,8)}]`,'');}
function action(text, fn) { const node=element('button',text); node.onclick=()=>perform(node,fn); return node; }
async function perform(button, fn) { button.disabled=true;notice('');try { await fn(); } catch(error){notice(error.message);} finally{button.disabled=false;} }
function step(index) { [1,2,3,4].forEach(i=>$('step'+i).classList.toggle('active',i===index)); }
function options(select, values, picked) { select.replaceChildren();for(const value of values){const opt=element('option',value.label);opt.value=value.value;select.append(opt);}if(picked!==undefined) select.value=picked; }
async function bootstrap() {
  try {const data=await api('/bootstrap');$('auth').hidden=true;
    $('logs-source').options[0].textContent=`Уже загруженные банковские диалоги · ${data.existing_count}`;
    $('reference-info').textContent=`В проекте: ${data.reference_count} статей. Поиск выбирает выдержки; отсутствие источника не означает ошибку.`;
    const agents=data.agents.map(a=>({label:a.name,value:a.id}));
    options($('agent'),agents.length?agents:[{label:'Нет подключённого HTTP агента',value:''}]);options($('run-agent'),agents.length?agents:[{label:'Нет подключённого HTTP агента',value:''}]);
    $('history').replaceChildren();for(const item of data.jobs){$('history').append(action(`${new Date(item.created_at*1000).toLocaleString('ru-RU')} · ${item.processed}/${item.selected} · ${item.name}`,()=>load(item.id)));}
    if(!data.jobs.length) $('history').textContent='Здесь появятся ваши разборы. Результаты сохраняются между перезапусками.';
    if(initial){initial=false;const query=new URLSearchParams(location.search);if(query.get('job')){const finding=query.get('finding');await load(query.get('job'));const selected=job.results.flatMap(r=>r.findings).find(f=>f.id===finding);if(selected)openCard(selected);}}
  }catch(error){notice(error.message);}
}
$('logs-source').onchange=()=>{$('upload').hidden=$('logs-source').value!=='upload';};
$('logs-file').onchange=async()=>{
  const file=$('logs-file').files[0];if(!file)return;
  notice('Читаю файл…');
  try {if(file.size>15000000)throw new Error('Выберите файл до 15 МБ');const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));upload=await api('/preview',{name:file.name,data:btoa(text)});options($('sheet'),upload.sheets.map((s,i)=>({label:`${s.name} · ${s.rows} строк`,value:String(i)})));mapping();$('mapping').hidden=false;notice('');}catch(error){upload=null;$('mapping').hidden=true;notice(error.message);}
};
function mapping(){const data=upload.sheets[Number($('sheet').value)];const cols=data.columns.map(x=>({label:x,value:x}));options($('id-column'),cols,data.columns.find(x=>['dialogue_id','Id диалога','id'].includes(x)));options($('text-column'),cols,data.columns.find(x=>['conversation','Текст','text'].includes(x)));$('preview').textContent=JSON.stringify(data.preview[0],null,2);}
$('sheet').onchange=mapping;
$('reference-file').onchange=async()=>{const file=$('reference-file').files[0];if(file){reference=await file.text();$('reference-info').textContent=`Выбран ${file.name} · ${reference.length} символов`;}};
$('analyze').onclick=()=>perform($('analyze'),async()=>{
  const existing=$('logs-source').value==='existing';if(!existing&&!upload)throw new Error('Сначала загрузите файл');
  const body={existing,token:upload?.token,sheet:Number($('sheet').value||0),id_column:$('id-column').value,text_column:$('text-column').value,
    rules:$('rules').value,use_reference:$('use-reference').checked,reference_text:reference,count:Number($('count').value)};
  job=await api('/analyze',body);history.replaceState(null,'',`/agent-review.html?job=${job.id}`);renderJob();watch();
});
async function load(id){clearTimeout(poll);clearTimeout(runPoll);job=await api('/job/'+id);history.replaceState(null,'',`/agent-review.html?job=${job.id}`);$('card-section').hidden=true;$('run-section').hidden=true;active=null;renderJob();if(job.status==='running')watch();}
function watch(){clearTimeout(poll);poll=setTimeout(async()=>{try{job=await api('/job/'+job.id);renderJob();if(job.status==='running')watch();else bootstrap();}catch(error){notice(error.message);}},4000);}
function renderJob(){ $('setup').hidden=true;$('analysis').hidden=false;step(2);
  $('analysis-title').textContent=job.status==='running'?'Разбираю разговоры':job.status==='done'?'Результат разбора':'Разбор не завершён';
  $('scope').textContent=`${job.name} · выбрано ${job.selected} из ${job.logged} · обработано ${job.processed}. Частота относится только к этой выборке.`;
  $('progress').textContent=`${job.message} · вызовов модели: ${job.calls}`;
  $('native-analysis').hidden=!job.dataset_url;if(job.dataset_url)$('native-analysis').href=job.dataset_url;if(job.publish_error)notice(job.publish_error);
  const counts={PASS:0,FAIL:0,UNKNOWN:0};job.results.forEach(r=>counts[r.status]++);
  $('stats').replaceChildren();for(const [status,label] of [['PASS','Проверенные правила соблюдены'],['FAIL','Разговоров с находками'],['UNKNOWN','Не удалось оценить']]){const box=element('div',undefined,'stat');box.append(element('b',counts[status]),element('span',label));$('stats').append(box);}
  $('findings').replaceChildren();
  for(const result of job.results){for(const finding of result.findings){const box=element('article',undefined,'finding');
    const labels={needs_review:'Вывод судьи · проверьте пример',confirmed:'Подтверждено',disputed:'Отклонено',unsure:'Нужны дополнительные данные'};
    box.append(element('span',labels[finding.owner_decision],'badge '+finding.owner_decision),element('h3',titleOf(finding)),element('p',finding.reason));
    box.append(element('div','Агент: «'+finding.agent_quote+'»','quote'),element('div','Правило: «'+finding.source_quote+'»\n'+finding.source_name,'quote'));
    const detail=element('details');detail.append(element('summary','Реальный разговор целиком · '+result.dialogue_id),element('pre',result.conversation));box.append(detail);
    if(finding.owner_reason)box.append(element('p','Решение: '+finding.owner_reason,'muted'));
    const note=element('textarea');note.placeholder='Основание решения: почему это нарушение или допустимый ответ';note.rows=2;note.setAttribute('aria-label','Основание решения');
    const actions=element('div',undefined,'actions');
    if(!finding.scenario_id){box.append(note);for(const [decision,label] of [['confirmed','Подтвердить нарушение'],['disputed','Отклонить'],['unsure','Недостаточно данных']])actions.append(action(label,async()=>{if(!note.value.trim())throw new Error('Укажите основание решения');job=await api('/review',{job:job.id,finding:finding.id,decision,note:note.value});renderJob();}));}
    if(finding.owner_decision==='confirmed')actions.append(action(finding.scenario_id?'Открыть карточку и прогон':'Сделать карточку',()=>openCard(finding)));
    box.append(actions);$('findings').append(box);
  }}
  if(!job.results.some(r=>r.findings.length))$('findings').append(element('p',job.status==='running'?'Здесь появятся находки с дословными доказательствами.':'Нарушений не найдено в оценённых правилах. Это не означает, что все разговоры прошли проверку.','muted'));
  $('results').replaceChildren();for(const result of job.results){const div=element('div',undefined,'result');div.append(element('strong',result.status+' · '+result.dialogue_id),element('p',result.reason));const d=element('details');d.append(element('summary','Открыть разговор'),element('pre',result.conversation));div.append(d);$('results').append(div);}
}
$('new-analysis').onclick=()=>{clearTimeout(poll);clearTimeout(runPoll);history.replaceState(null,'','/agent-review.html');$('setup').hidden=false;$('analysis').hidden=true;$('card-section').hidden=true;$('run-section').hidden=true;step(1);bootstrap();};
function nativeScenario(id){return `/local-dev-project-se7hbx/simulations/scenarios?drawer.open=scenarioEditor&drawer.scenarioId=${encodeURIComponent(id)}`;}
function openCard(finding){active=finding;history.replaceState(null,'',`/agent-review.html?job=${job.id}&finding=${finding.id}`);$('card-section').hidden=false;$('run-section').hidden=true;step(3);$('card-title').value=titleOf(finding);$('situation').value=finding.situation;$('criterion').value=finding.criterion;$('run-agent').value=finding.agent_id||$('agent').value;$('run').disabled=!finding.scenario_id;$('save-card').disabled=!!finding.scenario_id;['card-title','situation','criterion'].forEach(id=>$(id).disabled=!!finding.scenario_id);$('native-card').hidden=!finding.scenario_id;if(finding.scenario_id)$('native-card').href=nativeScenario(finding.scenario_id);$('card-section').scrollIntoView({behavior:'smooth'});if(finding.run_id)watchRun();}
$('save-card').onclick=()=>perform($('save-card'),async()=>{const finding=await api('/card',{job:job.id,finding:active.id,title:$('card-title').value,situation:$('situation').value,criterion:$('criterion').value});job=await api('/job/'+job.id);openCard(finding);}).then(()=>{$('save-card').disabled=!!active?.scenario_id;});
$('run').onclick=()=>perform($('run'),async()=>{if(!$('run-agent').value)throw new Error('Подключите HTTP агента в LangWatch');await api('/start-run',{job:job.id,finding:active.id,agent:$('run-agent').value});job=await api('/job/'+job.id);active=job.results.flatMap(x=>x.findings).find(x=>x.id===active.id);watchRun();});
async function watchRun(){clearTimeout(runPoll);$('run-section').hidden=false;step(4);try{const data=await api('/run/'+job.id+'/'+active.id);const labels={SUCCESS:'Проверка пройдена',FAILED:'Проблема воспроизвелась по оценке судьи',ERROR:'Прогон не удалось выполнить',IN_PROGRESS:'Агент разговаривает с клиентом',QUEUED:'Прогон в очереди',STALLED:'Прогон остановился',CANCELLED:'Прогон отменён'};$('run-title').textContent=labels[data.status]||data.status;$('run-reason').textContent=data.results?.reasoning||'Дождитесь завершения. Здесь появятся реальные реплики и оценка судьи.';$('native-run').href=data.platformUrl||`/local-dev-project-se7hbx/simulations?drawer.open=scenarioRunDetail&drawer.scenarioRunId=${active.run_id}`;$('trajectory').replaceChildren();for(const message of data.messages||[]){const div=element('div',undefined,'message '+message.role);div.append(element('strong',message.role==='user'?'Синтетический клиент':'Настоящий агент'),element('span',String(message.content||'')));$('trajectory').append(div);}if(['IN_PROGRESS','QUEUED','PENDING'].includes(data.status))runPoll=setTimeout(watchRun,5000);else{$('run-reason').append(element('p','Вывод относится к одной ситуации и записанным ответам. Новый PASS сам по себе не доказывает исправление без сравнения версий.','muted'));}}catch(error){notice(error.message);}}
bootstrap();
