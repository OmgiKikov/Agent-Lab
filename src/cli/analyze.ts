import { ExperimentLab } from '../experiment.js';
import type { CreateInput } from '../contracts.js';
import { demoAnalysisInput } from '../demo.js';
import { analysisConsentText } from '../discover/consent.js';
import type { LogAnalysis } from '../discover/schema.js';
import { analysisLines, nextStep } from '../discover/text.js';
import { analysisView } from '../discover/view.js';
import type { AnalyzeInput } from '../lab/discover.js';
import { MAX_WIDTH } from '../result-text.js';
import { ExperimentStore } from '../store.js';
import { safeLine, wrapHanging } from '../text.js';
import type { Flags } from './args.js';

/*
 * `agent-lab analyze` — the analysis of logged conversations against the owner's rules (DISCOVER) from the command line,
 * over the same engine operation as the chat: the consent without --yes, the analysis with it, an analysis shown again,
 * and the owner's word on one finding. What the command line needs of cli.ts comes in `deps`.
 */

/** What the command takes from cli.ts: the writer's lease, the task file read as an input (never with an agent), the output. */
export interface AnalyzeDeps {
  asWriter(directory: string, work: (lab: ExperimentLab) => Promise<void>): Promise<void>;
  taskInput(values: Flags, directory: string): Promise<{ input: CreateInput; logs: string }>;
  writeStdout(value: string): Promise<void>;
}

/** A finding of an analysis named by the owner: its key, or a prefix of at least six characters no other finding shares. */
function findingKey(analysis: LogAnalysis, named: string): string {
  const matches = analysis.findings.filter(finding => finding.key === named || named.length >= 6 && finding.key.startsWith(named));
  if (matches.length === 1) return matches[0]!.key;
  throw new Error(matches.length ? `Начало «${named}» подходит к нескольким находкам: напишите больше знаков.` : `Находки «${named}» в разборе ${analysis.id} нет. Список: agent-lab analyze --id ${analysis.id}.`);
}

/** An analysis in the owner's words, with the key of every example, so a finding can be confirmed or disputed by it. */
async function analysisText(store: ExperimentStore, analysis: LogAnalysis): Promise<string> {
  const batch = await store.readImport(analysis.logs.importId).catch(() => undefined);
  const view = analysisView(analysis, batch);
  const keys = view.problems.flatMap((problem, index) => problem.examples.map(example => `  ${index + 1}. разговор ${example.dialogueId}: ${example.key.slice(0, 10)}`));
  const width = Math.min(process.stdout.columns ?? MAX_WIDTH, MAX_WIDTH);
  return `${[...analysisLines(view, { examples: 2 }), '', nextStep(view),
    ...(keys.length ? ['', 'Находки по ключам (подтвердить или оспорить):', ...keys,
      `  agent-lab analyze --id ${analysis.id} --finding КЛЮЧ --verdict confirmed|disputed|unsure [--note "почему"] --yes`] : [])]
    .flatMap(line => {
      if (!line) return [''];
      // A continued line keeps its own indent and hangs under its text.
      let indent = 0;
      while (line[indent] === ' ') indent++;
      return wrapHanging(safeLine(line.slice(indent)), width - indent, width - indent - 3).map((part, index) => `${' '.repeat(index ? indent + 3 : indent)}${part}`);
    })
    .join('\n')}\n`;
}

/**
 * `analyze` (DISCOVER): the owner's rules put to the logged conversations — no situation, no agent, no simulated
 * customer. Without --yes it shows the consent and spends nothing; `--id` shows an analysis; `--finding` with `--verdict`
 * and --yes records the owner's word on one finding; `--demo` analyses the teaching example's logs, free.
 */
export async function analyzeCommand({ values, directory }: { values: Flags; directory: string }, deps: AnalyzeDeps): Promise<void> {
  const { asWriter, taskInput, writeStdout } = deps;
  if (values.id && values.finding) {
    const verdict = values.verdict;
    if (verdict !== 'confirmed' && verdict !== 'disputed' && verdict !== 'unsure') throw new Error('Укажите --verdict confirmed (нарушение есть), disputed (нарушения нет — с --note почему) или unsure (не знаю).');
    if (!values.yes) throw new Error('Отметка владельца пишется только с --yes.');
    const id = values.id, named = values.finding;
    await asWriter(directory, async lab => {
      const key = findingKey(await lab.getAnalysis(id), named);
      const analysis = await lab.reviewFinding(id, { key, verdict, note: values.note ?? '', via: 'cli-yes' });
      await writeStdout(values.json ? `${JSON.stringify(analysisView(analysis), null, 2)}\n` : await analysisText(lab.store, analysis));
    });
    return;
  }
  if (values.id) {
    const store = new ExperimentStore(directory);
    const analysis = await store.readAnalysis(values.id);
    await writeStdout(values.json ? `${JSON.stringify(analysisView(analysis, await store.readImport(analysis.logs.importId).catch(() => undefined)), null, 2)}\n` : await analysisText(store, analysis));
    return;
  }
  let input: AnalyzeInput;
  if (values.demo) input = demoAnalysisInput();
  else {
    if (!values['dialogues-file']) throw new Error('Укажите логи: agent-lab analyze --input задача.json --dialogues-file логи.jsonl. В задаче — что делает агент, материалы с правилами и модели.');
    const task = await taskInput(values, directory);
    input = { task: task.input.task, mode: task.input.mode, materials: task.input.materials, logs: task.input.originalImport!, file: task.logs, settings: task.input.settings,
      ...(values.conversations === undefined ? {} : { requested: Number(values.conversations) }) };
  }
  const consent = await new ExperimentLab(directory).analysisConsent(input);
  const text = analysisConsentText(consent, input.file);
  if (!values.yes && !values.demo) {
    await writeStdout(values.json ? `${JSON.stringify({ question: text.question, lines: text.lines, conversations: consent.analysed, callCeiling: consent.callCeiling }, null, 2)}\n`
      : `${[text.question, '', ...text.lines, '', 'Разобрать: та же команда с --yes. Без него ничего не записано и не потрачено.'].map(line => safeLine(line)).join('\n')}\n`);
    return;
  }
  await asWriter(directory, async lab => {
    const started = await lab.analyze(input, { callCeiling: consent.callCeiling });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    await writeStdout(values.json ? `${JSON.stringify(analysisView(analysis, await lab.store.readImport(analysis.logs.importId).catch(() => undefined)), null, 2)}\n`
      : `${await analysisText(lab.store, analysis)}\nРазбор: ${analysis.id}\n`);
    if (analysis.status === 'failed') process.exitCode = 1;
  });
}

