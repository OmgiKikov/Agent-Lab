import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ExperimentLab } from '../src/experiment.js';
import { fingerprint, type Experiment } from '../src/contracts.js';
import { diagnosticCapability, type Intervention } from '../src/diagnostics.js';
import { diagnosticText, issueEvidenceText, trialText, resolutionText, resolutionRunText } from '../src/issue-view.js';
const clean = (text: string) => stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
async function choose<T>(ctx: ExtensionContext, title: string, values: T[], label: (value: T) => string): Promise<T | undefined> {
  let offset = 0;
  while (true) {
    const rows = values.slice(offset, offset + 12), labels = rows.map((v, n) => `${offset + n + 1}. ${clean(label(v))}`);
    const selected = await ctx.ui.select(title, [...labels, ...(offset ? ['← Назад по списку'] : []), ...(offset + 12 < values.length ? ['Далее по списку →'] : [])]);
    if (!selected) return;
    if (selected === 'Далее по списку →') { offset += 12; continue; }
    if (selected === '← Назад по списку') { offset -= 12; continue; }
    return rows[labels.indexOf(selected)];
  }
}
/** Read-only full evidence viewer; its content is never written back as an owner edit. */
export async function showIssueText(ctx: ExtensionContext, title: string, content: string): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0, max = 0;
    return { invalidate() {}, handleInput(key) { if (matchesKey(key, 'escape') || matchesKey(key, 'enter')) done(); else { offset = Math.max(0, Math.min(max, offset + (matchesKey(key, 'pageDown') ? 15 : matchesKey(key, 'pageUp') ? -15 : matchesKey(key, 'down') ? 1 : matchesKey(key, 'up') ? -1 : 0))); tui.requestRender(); } },
      render(width) { const rows = wrapTextWithAnsi(clean(content), Math.max(1, width)), height = Math.max(1, tui.terminal.rows - 3); max = Math.max(0, rows.length - height); return [theme.fg('accent', clean(title)), ...rows.slice(offset, offset + height), '↑↓ PgUp/PgDn — текст · Enter/Esc — назад'].flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).slice(0, tui.terminal.rows); } };
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
export async function showIssueWorkspace(ctx: ExtensionContext, record: Experiment, reader: ExperimentLab, writer: () => Promise<ExperimentLab>): Promise<string | undefined> {
  const all = await reader.store.readIssues();
  const issues = all.filter(i => !i.mergedInto && (i.evidence.some(e => e.runId === record.id) || record.runKind === 'diagnostic' && i.evidence.some(e => e.runId === record.parentRunId)));
  if (!issues.length) { if (await ctx.ui.select('Для этого прогона проблем пока нет', ['Обновить проблемы из сохранённых оценок'])) { const lab = await writer(); await lab.store.syncIssues(record); await showIssueText(ctx, 'Постоянные проблемы', 'Индекс обновлён. Откройте проблемы повторно; если пригодных провалов нет, список останется пустым.'); } return; }
  const issue = await choose(ctx, 'Постоянные проблемы', issues, i => `${i.observation} · ${i.kind === 'defect' ? 'дефект' : 'возможность'} · независимых попыток ${i.occurrences.length}`);
  if (!issue) return;
  while (true) {
    const action = await ctx.ui.select(clean(issue.observation), ['Точная исходная оценка и трасса', 'Пакет исправления для билдера', 'Предложить исправление промпта', 'Зарегистрировать внешнего кандидата', 'Сохранить правило проверки исправления', 'Сохранённые проверки исправления', 'Подготовить парную диагностику', 'Сохранённые диагностики', 'Объединить по решению владельца']);
    if (!action) return;
    if (action === 'Точная исходная оценка и трасса') {
      const evidence = await choose(ctx, 'Выберите сохранённую оценку', issue.evidence, e => `${e.runId.slice(0, 8)} · ${e.trialId.slice(0, 8)} · ${e.assessmentId.slice(0, 12)}`);
      if (evidence) await showIssueText(ctx, `Оценка ${evidence.assessmentId}`, issueEvidenceText(evidence));
    } else if (['Пакет исправления для билдера','Предложить исправление промпта','Зарегистрировать внешнего кандидата','Сохранить правило проверки исправления'].includes(action)) {
      const sourceRuns=await Promise.all([...new Set(issue.evidence.map(e=>e.runId))].map(id=>reader.get(id)));
      const sourceId=(await choose(ctx,'Исходный прогон',sourceRuns,r=>`${r.task} · ${r.targetVersion??'исходная версия'} · ${r.createdAt.slice(0,10)} · ${r.id.slice(0,8)}`))?.id; if(!sourceId) continue;
      const source=await reader.get(sourceId);
      if(action==='Пакет исправления для билдера') {
        await showIssueText(ctx,'Dev-пакет для билдера',JSON.stringify(await reader.createFixBundle(issue.id,sourceId),null,2));
      } else if(action==='Предложить исправление промпта') {
        if(source.target.kind==='sandbox'||!source.target.promptFile) { await showIssueText(ctx,'Нужен промпт агента','Укажите promptFile в подключении внешнего агента с подтверждением promptHash.'); continue; }
        const bundle=await reader.createFixBundle(issue.id,sourceId);
        const proof=await choose(ctx,'Фактически подтверждённая человеком dev-ошибка',bundle.devTrials,t=>t.id); if(!proof) continue;
        const hypothesis=await ctx.ui.editor('Гипотеза исправления',''); if(!hypothesis?.trim()) continue;
        const candidate=await ctx.ui.editor('Отдельный кандидат промпта',await readFile(source.target.promptFile,'utf8')); if(!candidate?.trim()) continue;
        try {
          const lab=await writer(),proposal=await lab.proposeIssueFix(issue.id,sourceId,{candidate,hypothesis,trialIds:[proof.id]});
          await showIssueText(ctx,'Изменение кандидата',proposal.diff);
          if(await ctx.ui.confirm('Подготовить отдельную версию?', 'Промпт исходного агента сохранится. Затем нужно заранее сохранить правило проверки.')) { const draft=await lab.promptCandidate(proposal.file,proposal.reviewHash); await showIssueText(ctx,'Кандидат подготовлен',`Кандидат ${draft.id}. Выберите «Сохранить правило проверки исправления».`); }
        } catch(error) { await showIssueText(ctx,'Предложение недоступно',(error as Error).message); }
      } else if(action==='Зарегистрировать внешнего кандидата') {
        const target=await ctx.ui.editor('Подключение отдельного кандидата (JSON)',JSON.stringify(source.target,null,2)); if(!target) continue;
        const targetVersion=await ctx.ui.input('Неизменная версия кандидата (например, commit)'); if(!targetVersion?.trim()) continue;
        const lab=await writer(),draft=await lab.registerCandidate(sourceId,{target:JSON.parse(target),targetVersion});
        await showIssueText(ctx,'Кандидат подготовлен',`Кандидат ${draft.id}. Набор и оценщик сохранены. Выберите «Сохранить правило проверки исправления».`);
      } else {
        const candidate=await choose(ctx,'Неисполненный кандидат того же набора',(await reader.list()).filter(r=>r.phase==='review'&&r.parentRunId===sourceId&&!r.trials.length),r=>`${r.targetVersion??r.id} · ${r.id}`); if(!candidate) continue;
        const defaults=[...new Set(issue.evidence.filter(e=>e.runId===sourceId).map(e=>e.assessment.scenario.id))];
        const names=defaults.map(id=>source.scenarios.find(s=>s.id===id)?.title??id).join('; ');
        const selection=await ctx.ui.select(`Воспроизводящие варианты: ${clean(names)}`,['Использовать варианты проблемы','Выбрать варианты']); if(!selection) continue;
        let reproducerIds=[...defaults];
        if(selection==='Выбрать варианты') {
          const available=source.scenarios.filter(s=>!source.positiveControlScenarioIds?.includes(s.id));
          while(true) {
            const choice=await choose(ctx,'Воспроизводящий набор · отметьте варианты',[{id:'',title:'Готово'},...available],s=>s.id?`${reproducerIds.includes(s.id)?'✓ ':''}${s.title}`:s.title);
            if(!choice) {reproducerIds=[];break;} if(!choice.id) break;
            reproducerIds=reproducerIds.includes(choice.id)?reproducerIds.filter(id=>id!==choice.id):[...reproducerIds,choice.id];
          }
          if(!reproducerIds.length) continue;
        }
        const regressionIds=source.scenarios.filter(s=>!reproducerIds.includes(s.id)&&!source.positiveControlScenarioIds?.includes(s.id)).map(s=>s.id);
        if(!await ctx.ui.confirm('Сохранить неизменное правило до запуска?',`${source.settings.repeats} повторов каждого варианта. Все обязательные критерии должны пройти.\nВоспроизведение: ${source.scenarios.filter(s=>reproducerIds.includes(s.id)).map(s=>s.title).join('; ')}\nОтдельные обязательные регрессии: ${source.scenarios.filter(s=>regressionIds.includes(s.id)).map(s=>s.title).join('; ')}\nИзменение правила потребует новых прогонов обеих версий.`)) continue;
        const lab=await writer(),policy=await lab.prepareResolution({issueId:issue.id,baselineRunId:sourceId,candidateRunId:candidate.id,reproducerIds,regressionIds,stability:{kind:'all-pass',repeats:source.settings.repeats}});
        await showIssueText(ctx,'Правило сохранено',resolutionText(await lab.store.readResolution(policy.id)));
      }
    } else if(action==='Сохранённые проверки исправления') {
      const journal=await reader.store.readIssueJournal(),selected=await choose(ctx,'Проверки исправления',journal.resolutions.filter(f=>f.policy.issueId===issue.id),f=>`${f.policy.id} · ${f.result?.candidateAcceptable===true?'принят':f.result?'решение сохранено':'ожидает исполнения'}`); if(!selected) continue;
      let file=selected;
      while(true) {
        const choice=await ctx.ui.select('Проверка исправления',['Правило и два решения','План и бюджет кандидата','Открыть кандидатный прогон',...(!file.result&&!file.startedAt?['Запустить по сохранённому правилу']:[]),...(!file.result&&file.startedAt?['Сохранить решение по результатам']:[])]); if(!choice) break;
        if(choice==='Правило и два решения') await showIssueText(ctx,'Проверка исправления',resolutionText(file));
        else if(choice==='План и бюджет кандидата') await showIssueText(ctx,'План кандидата',resolutionRunText(file,await reader.get(file.policy.candidateRunId)));
        else if(choice==='Открыть кандидатный прогон') return file.policy.candidateRunId;
        else {
          const lab=await writer();
          if(choice==='Запустить по сохранённому правилу') {
            if(!await ctx.ui.confirm('Запустить кандидата?',resolutionRunText(file,await reader.get(file.policy.candidateRunId)))) continue;
            const run=await lab.startResolution(file.policy.id,{approved:true}),cancel=()=>{void lab.cancel(run.id);};
            ctx.signal?.addEventListener('abort',cancel,{once:true}); if(ctx.signal?.aborted) cancel();
            try { await lab.waitForIdle(); } finally {ctx.signal?.removeEventListener('abort',cancel);}
          }
          await lab.resolveIssue(file.policy.id); file=await lab.store.readResolution(file.policy.id);
          await showIssueText(ctx,'Два решения проверки',resolutionText(file));
        }
      }
    } else if (action === 'Объединить по решению владельца') {
      const candidate = await choose(ctx, 'Проблема с тем же критерием', all.filter(i => i.id !== issue.id && !i.mergedInto && i.kind === issue.kind && i.identity.criterionHash === issue.identity.criterionHash), i => `${i.observation} · ${i.identity.mechanism}`);
      if (!candidate) continue;
      const reason = await ctx.ui.editor('Основание объединения', ''); if (!reason?.trim()) continue;
      if (!await ctx.ui.confirm('Сохранить решение владельца?', clean(`${candidate.observation} → ${issue.observation}\n${reason}`))) continue;
      const lab = await writer(); await lab.store.decideIssue({ id: randomUUID(), fromIssueId: candidate.id, intoIssueId: issue.id, reason, at: new Date().toISOString() }); return;
    } else {
      let planId: string | undefined;
      if (action === 'Подготовить парную диагностику') {
        const evidence = await choose(ctx, 'Исходный прогон и неизменная оценка', issue.evidence, e => `${e.runId.slice(0, 8)} · ${e.assessmentId.slice(0, 12)}`); if (!evidence) continue;
        const source = await reader.get(evidence.runId);
        const kind = await ctx.ui.select('Один изменяемый фактор', ['Ответ fixture-инструмента', 'Проверенный RAG-фрагмент']); if (!kind) continue;
        const probe: Intervention = kind === 'Ответ fixture-инструмента' ? { kind: 'tool-response', tool: 'update_record', call: 1, response: null, hypothesis: 'Проверка' } : { kind: 'rag-fragment', sourceId: 'source', sourceHash: 'a'.repeat(64), content: 'fragment', hypothesis: 'Проверка' };
        const available = diagnosticCapability(source.target, probe);
        if (!available.supported) { await showIssueText(ctx, 'Вмешательство недоступно', available.reason); continue; }
        const hypothesis = await ctx.ui.editor('Какую гипотезу проверяем?', ''); if (!hypothesis?.trim()) continue;
        let intervention: Intervention;
        if (probe.kind === 'tool-response') {
          const tool = await choose(ctx, 'Инструмент', source.revisions.find(r => r.id === evidence.assessment.trial.revisionId)?.spec.tools ?? [], t => t); if (!tool) continue;
          const nth = await ctx.ui.input('Номер вызова этого инструмента', '1'); if (nth === undefined) continue;
          const response = await ctx.ui.editor('Подставляемый ответ инструмента (JSON); реальная операция и её состояние сохраняются', '{"ok":false,"error":"Проверенная ошибка","retryable":true}'); if (response === undefined) continue;
          intervention = { kind: 'tool-response', tool, call: Number(nth), response: JSON.parse(response), hypothesis };
        } else {
          const material = await choose(ctx, 'Источник проверенного фрагмента', source.sources.filter(s => s.kind !== 'prompt'), s => s.name); if (!material) continue;
          const content = await ctx.ui.editor('Дословный фрагмент сохранённого источника', material.content); if (!content?.trim()) continue;
          intervention = { kind: 'rag-fragment', sourceId: material.id, sourceHash: fingerprint(material.content), content, hypothesis };
        }
        const repeats = await ctx.ui.select('Сколько пар выполнить?', ['1', '2', '3', '4', '5']); if (!repeats) continue;
        const lab = await writer(); planId = (await lab.prepareDiagnostic(issue.id, source.id, intervention, Number(repeats))).id;
      } else {
        const current = (await reader.store.readIssues()).find(i => i.id === issue.id)!;
        planId = await choose(ctx, 'Сохранённые диагностики', current.experiments.filter(id=>id.startsWith('diag_')), id => id);
      }
      if (!planId) continue;
      let file = await reader.store.readDiagnostic(planId);
      while (true) {
        const choice = await ctx.ui.select('Парная диагностика', ['План и результат', 'Технические данные плана', ...(file.runId ? ['Открыть трассу пары', 'Открыть прогон'] : ['Запустить обе стороны'])]); if (!choice) break;
        if (choice === 'План и результат') await showIssueText(ctx, 'План и результат диагностики', diagnosticText(file));
        else if (choice === 'Технические данные плана') await showIssueText(ctx, 'Технические данные плана', JSON.stringify(file, null, 2));
        else if (choice === 'Открыть прогон') return file.runId;
        else if (choice === 'Открыть трассу пары' && file.runId) {
          const run = await reader.get(file.runId), trial = await choose(ctx, 'Исходные трассы', run.trials, t => `${t.diagnosticReceipt?.arm === 'intervention' ? 'Вмешательство' : 'Исходные условия'} · попытка ${t.repeat + 1} · ${t.id.slice(0, 8)}`);
          if (trial) await showIssueText(ctx, `Трасса ${trial.id}`, trialText(trial));
        } else {
          const plan = file.plan;
          if (!await ctx.ui.confirm('Запустить обе стороны?', clean(`${plan.intervention.hypothesis}\n${plan.repeats * plan.source.settings.userModes.length} пар, ${plan.budget.maxCalls} вызовов и ${Math.round(plan.budget.maxDurationMs / 1000)} секунд на обе стороны вместе.\nДиагностика исключена из точности и не закрывает проблему.`))) continue;
          ctx.signal?.throwIfAborted();
          const lab = await writer(), run = await lab.startDiagnostic(planId);
          const cancel = () => { void lab.cancel(run.id); }; ctx.signal?.addEventListener('abort', cancel, { once: true }); if (ctx.signal?.aborted) cancel();
          try { await lab.waitForIdle(); } finally { ctx.signal?.removeEventListener('abort', cancel); }
          file = await lab.store.readDiagnostic(planId);
        }
      }
    }
  }
}
