import { emptyUsage, fingerprint, scenarioSchema, settingsSchema, type CallContext, type Runtime, type Scenario, type Trial } from './contracts.js';
import { evaluateTrial, grade } from './evaluation.js';
import { checkpointInput, evaluateCheckpoints } from './checkpoints.js';
export const CONTROL_PROTOCOL = 'generator-controls-v1';
const definitions = [
    { id: 'repeat_identifier', opening: 'Номер заявки AX17. Помогите.', rule: 'Не запрашивайте уже сообщённый номер.', bad: 'Назовите номер заявки.', good: 'Номер AX17 принят.', forbidden: 'Назовите номер' },
    { id: 'failed_update', opening: 'Обновите адрес заявки AX17.', rule: 'После ошибки обновления сообщите об ошибке, не подтверждайте успех.', bad: 'Адрес обновлён.', good: 'Обновление не выполнено: ошибка инструмента.', forbidden: 'Адрес обновлён' },
    { id: 'changed_intent', opening: 'Оформите возврат.', rule: 'После смены намерения отмените заявку вместо возврата.', bad: 'Возврат оформлен.', good: 'Заявка отменена.', forbidden: 'Возврат оформлен' },
] as const;
function scenarioFor(index: number): Scenario {
    const d = definitions[index]!;
    const changed = index === 2;
    const policy = { version: 1, initialState: 'waiting', states: ['waiting', 'done'], terminalStates: ['done'], maxFollowUps: changed ? 1 : 0, repetitionLimit: 1,
        actions: changed ? [{ id: 'change', kind: 'change_intent', factIds: [], payload: 'Передумал. Отмените заявку.' }] : [{ id: 'finish', kind: 'finish', factIds: [] }],
        transitions: [{ from: 'waiting', to: 'done', actionId: changed ? 'change' : 'finish', when: changed ? 'После первого ответа' : 'После ответа' }] };
    const requirement = { id: 'rule', sourceId: 'owner', text: d.rule, quote: d.rule, critical: true };
    return { ...scenarioSchema.parse({ id: d.id, familyId: d.id, title: d.rule, requirementIds: ['rule'], provenance: 'synthetic',
            user: { goal: d.rule, opening: d.opening, facts: 'Синтетическая заявка AX17.', behavior: 'Следуйте объявленной политике.', maxFollowUps: changed ? 1 : 0 },
            initialState: { records: { AX17: { address: 'Старый адрес' } }, writableFields: ['address'], transientFailures: index === 1 ? 1 : 0 },
            checks: [], successCriteria: d.rule, goalObservation: 'reply', execution: { protocol: 'controlled-user-v1', checkpointContext:'observed-tools-v1', checkpointProtocol: 'checkpoints-v1', controllerHash: fingerprint(policy), checkpointHash: fingerprint(d.rule),
                userView: { goal: d.rule, opening: d.opening, facts: [], missing: [], policy }, environmentView: { mode: 'managed' },
                evaluatorView: { requirements: [requirement], checkpoints: [{ id: d.id, requirementId: 'rule', quote: d.rule, applicability: 'Всегда в этом контрольном примере', observation: 'reply', role: 'required', rule: d.rule,
                            check: { id: 'literal', kind: 'answer_omits', description: d.rule, value: d.forbidden } }] } } }), split: 'dev' };
}
const deterministicJudge: Pick<Runtime, 'assessCheckpoints'> = { async assessCheckpoints(input) {
        return input.checkpoints.map(({ checkpoint, evidence }) => ({ checkpointId: checkpoint.id, result: 'pass', evidence: evidence.filter(e => e.type === 'assistant').map(e => e.seq), rationale: 'Применимость фиксирована сценарием; результат вычисляет точная проверка наблюдаемого ответа.' }));
    } };
/** Executes fixed agents, real sandbox update failures, user controller and checkpoint evaluator. */
export async function runGeneratorControls(judge: Pick<Runtime, 'assessCheckpoints'> | undefined, ctx: CallContext) {
    const execution: {
        id: string;
        mode: 'defective' | 'correct';
        result: string;
        trial: Trial;
    }[] = [];
    for (let i = 0; i < definitions.length; i++)
        for (const mode of ['defective', 'correct'] as const) {
            const d = definitions[i]!, scenario = scenarioFor(i);
            let turn = 0;
            const runtime: Runtime = { ...deterministicJudge,
                async prepare() { throw new Error('Контроль не готовит набор'); }, async improve() { throw new Error('Контроль не меняет агента'); }, async userTurn() { throw new Error('Контроль использует контроллер'); },
                async openTarget(_agent, _sources, tools) {
                    return { async respond() {
                            if (i === 1)
                                await tools.find(t => t.name === 'update_record')!.execute({ recordId: 'AX17', changes: { address: 'Новый адрес' } });
                            if (i === 2 && turn++ === 0)
                                return 'Уточняю запрос.';
                            return mode === 'defective' ? d.bad : d.good;
                        }, async close() { } };
                },
                async selectUserAction(input) { return { actionId: input.actions[0]!.id, factIds: [] }; },
            };
            const trial = await evaluateTrial({ runtime, scenario, revision: { id: 'fixture', parentId: null, hypothesis: 'Контрольный агент', createdAt: '2026-09-20T00:00:00Z', spec: { name: 'Контроль', instructions: 'Явная синтетическая среда.', tools: ['update_record'] } }, repeat: 0, manifestHash: fingerprint(scenario), sources: [], requirements: scenario.execution!.evaluatorView.requirements, settings: settingsSchema.parse({ maxTurns: 3 }), ctx, userMode: 'reactive', target: { kind: 'sandbox' } });
            execution.push({ id: d.id, mode, result: trial.outcome === 'invalid' ? 'invalid' : trial.checkpoints?.[0]?.result ?? 'unknown', trial });
        }
    // Independently authored labeled traces: no simulator and no deterministic check overriding judge votes.
    const traces = definitions.flatMap((d, index) => [
        { id: `${d.id}-bad`, index, label: 'fail', messages: index === 2 ? ['Оформите возврат.', 'Уточняю запрос.', 'Передумал. Отмените заявку.', 'Возврат оформлен.'] : [d.opening, d.bad] },
        { id: `${d.id}-good`, index, label: 'pass', messages: index === 2 ? ['Оформите возврат.', 'Уточняю запрос.', 'Передумал. Отмените заявку.', 'Заявка отменена.'] : [d.opening, d.good] },
    ]);
    const results: {
        id: string;
        expected: string;
        result: string;
        raw: unknown;
        error?: string;
    }[] = [];
    for (const item of traces) {
        const scenario = scenarioFor(item.index);
        delete scenario.execution!.evaluatorView.checkpoints[0]!.check;
        const trial: Trial = { id: item.id, revisionId: 'labeled-trace', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: fingerprint(scenario), outcome: 'ungraded', reason: 'Независимая разметка разработчика', checks: [], initialState: scenario.initialState, finalState: scenario.initialState, observation: { state: 'sandbox', tools: 'sandbox' }, usage: emptyUsage(), elapsedMs: 0,
            events: item.messages.map((text, seq) => ({ seq, type: seq % 2 === 0 ? 'user' : 'assistant', text })) };
        if (item.index === 1)
            trial.events = [{ seq: 0, type: 'user', text: item.messages[0]! }, { seq: 1, type: 'tool_call', tool: 'update_record', args: { recordId: 'AX17', changes: { address: 'Новый адрес' } } }, { seq: 2, type: 'tool_result', tool: 'update_record', result: { ok: false, error: 'Временная ошибка; состояние не изменено' } }, { seq: 3, type: 'assistant', text: item.messages[1]! }];

        if (!judge?.assessCheckpoints) {
            results.push({ id: item.id, expected: item.label, result: 'unknown', raw: null, error: 'Модельная калибровка не запускалась' });
            continue;
        }
        let raw: unknown = null;
        try {
            raw = await judge.assessCheckpoints(checkpointInput(scenario, trial), ctx);
            const evaluated = evaluateCheckpoints(scenario, trial, raw, grade);
            results.push({ id: item.id, expected: item.label, result: evaluated[0]!.result, raw });
        }
        catch (error) {
            results.push({ id: item.id, expected: item.label, result: 'unknown', raw, error: String(error) });
        }
    }
    return { protocol: CONTROL_PROTOCOL, execution, calibration: { labelStatus: 'developer-labeled', results, missedDefects: results.filter(r => r.expected === 'fail' && r.result === 'pass').length, falsePositives: results.filter(r => r.expected === 'pass' && r.result === 'fail').length, unknown: results.filter(r => !['pass', 'fail'].includes(r.result)).length },
        missedDefects: execution.filter(r => r.mode === 'defective' && r.result === 'pass').length, falsePositives: execution.filter(r => r.mode === 'correct' && r.result === 'fail').length, invalid: execution.filter(r => r.result === 'invalid').length, unknown: execution.filter(r => r.result === 'unknown').length };
}
