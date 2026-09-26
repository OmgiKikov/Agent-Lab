/*
 * H — DISCOVER on its own in /agent-lab (item 5): in a folder with an analysis and no card or run the owner opens the
 * analysis, its problem, its example and the whole logged conversation; their key is their word on the judge's finding,
 * recorded and then shown; an older analysis stays reachable after a newer one; with two agents in the folder an
 * analysis belongs only to the agent a record links it to. The real workspace components, drawn with a plain theme.
 */
import { join } from 'node:path';
import { createDemoAnalysisRuntime, demoAnalysisInput } from '../../src/demo.js';
import { analysisView } from '../../src/discover/view.js';
import type { LogAnalysis } from '../../src/discover/schema.js';
import { ExperimentLab } from '../../src/experiment.js';
import { analysisOwners, agentSpaces } from '../../src/workspace.js';
import { AnalysisBoard, newAnalysisState, type AnalysisAction, type AnalysisBoardState } from '../../extensions/analysis-board.ts';
import { analysesView, workspaceView } from '../../extensions/board-command.ts';
import { LabWorkspace, newState, type WorkspaceAction } from '../../extensions/workspace.ts';
import { checkLink } from '../../src/discover/verify.js';
import { claim, folder, preparedCheck } from './common.js';

const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never;
const ENTER = '\r';
const screenOf = (component: { render(width: number): string[] }) => component.render(120).join('\n');

export async function proofBoard(): Promise<void> {
  const lab = new ExperimentLab(join(await folder('board'), '.agent-lab'), createDemoAnalysisRuntime());
  await lab.init();
  try {
    const first = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();

    // (1) A clean folder: no record of a run or a card, and the analysis opens on its own.
    const view = await workspaceView(lab, newState(), undefined);
    let chosen: WorkspaceAction | undefined;
    const workspace = new LabWorkspace(view, newState(), plain, action => { chosen = action; }, () => {}, () => 40);
    const start = screenOf(workspace);
    workspace.handleInput(ENTER);
    claim('H', (await lab.list()).length === 0 && view.agents.length === 0 && view.logs?.count === 1 && start.includes('Разборы логов — 1') && chosen?.type === 'analyses',
      `(1) no run or card in the folder: /agent-lab lists «Разборы логов — ${view.logs?.count}» (${view.logs?.unlinked} of no agent); Enter → ${chosen?.type}`);

    // (2) From the result to the evidence and the whole conversation; the owner's key is their word, then shown.
    const state: AnalysisBoardState = newAnalysisState();
    let action: AnalysisAction | undefined;
    const open = async () => new AnalysisBoard(await analysesView(lab), state, plain, done => { action = done; }, () => {}, () => 200);
    let board = await open();
    board.handleInput(ENTER); board.handleInput(ENTER); board.handleInput(ENTER);
    const example = screenOf(board);
    const known = (await lab.store.readImport((await lab.getAnalysis(first.id)).logs.importId)).dialogues.find(dialogue => dialogue.id === 'known')!;
    const whole = known.events.every(event => example.includes(event.content ?? '\u0000'));
    claim('H', whole && example.includes('Разговор known целиком') && example.includes('Вы ещё не отмечали'),
      `(2) analysis → problem → example: the evidence and the whole logged conversation «known» (${known.events.length} events, all shown), no mark yet`);
    board.handleInput('2');
    claim('H', action?.type === 'review' && action.verdict === 'disputed', `(2) key 2 on the example → ${JSON.stringify(action && { type: action.type, ...('verdict' in action ? { verdict: action.verdict } : {}) })}; the command asks the reason natively`);
    if (action?.type === 'review') await lab.reviewFinding(action.analysisId, { key: action.key, verdict: action.verdict, note: 'Номер уточняли для другого терминала', via: 'pi-confirm' });
    board = await open();
    const marked = screenOf(board);
    const stored = (await lab.getAnalysis(first.id)).reviews.at(-1);
    claim('H', marked.includes('Ваша отметка: вы оспорили') && stored?.via === 'pi-confirm' && stored.verdict === 'disputed',
      `(2) back on the same example: «Ваша отметка: вы оспорили»; stored beside the judge's verdict (${stored?.judgeVerdict}), via ${stored?.via}`);

    // (3) A newer analysis never replaces an older one.
    const second = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    const both = await analysesView(lab);
    const older = new AnalysisBoard(both, newAnalysisState({ id: first.id }), plain, () => {}, () => {}, () => 200);
    claim('H', both.entries.length === 2 && both.entries[0]!.analysis.id === second.id && screenOf(older).includes(`Разбор ${first.id}`),
      `(3) two analyses listed newest first; the older one still opens (${first.id.slice(0, 17)}…)`);

    // (4) Two agents: an analysis belongs to the agent a record links it to — never to every agent as «the newest».
    const analysis: LogAnalysis = await lab.getAnalysis(first.id);
    const problem = analysisView(analysis, await lab.store.readImport(analysis.logs.importId)).problems[0]!;
    const check = await preparedCheck(lab, analysis, checkLink(analysis, problem).link, ['known']);
    const other = { ...structuredClone(check), id: `${check.id}-other`, mode: 'live' as const, target: { kind: 'command' as const, command: 'other-agent', args: [], timeoutMs: 60000 } };
    delete other.fromAnalysis; delete other.originalImport; delete other.librarySnapshot;
    const spaces = agentSpaces([check, other]);
    const owners = analysisOwners(spaces, [analysis, await lab.getAnalysis(second.id)]);
    claim('H', spaces.length === 2 && owners.get(first.id) === 'demo' && !owners.has(second.id) && ![...owners.values()].includes(spaces.find(space => space.key !== 'demo')!.key),
      `(4) two agents: the analysis a check was made from belongs to «${owners.get(first.id)}»; the other analysis links to none (${owners.has(second.id) ? 'linked' : 'its import only'}); the other agent gets none`);
  } finally { await lab.close(); }
}
