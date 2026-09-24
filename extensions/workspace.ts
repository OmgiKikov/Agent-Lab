import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { MAX_WIDTH } from '../src/result-text.js';
import type { Experiment } from '../src/contracts.js';
import { situationActions, type SituationAction, type SituationView } from '../src/card/view.js';
import type { DecisionChoice } from '../src/inbox.js';
import type { AgentSpace } from '../src/workspace.js';
import { agreementTarget, type Answer } from './judge-review.ts';
import type { Tone } from './render/theme.ts';
import { agentsScreen, allRunsScreen, areasOf, header, helpScreen, inboxScreen, judgedScreen, problemScreen, problemsScreen, resultScreen, runActions, runStepScreen,
  situationScreen, situationsScreen, startScreen, type Area, type Hint, type Line, type ResultPick, type Screen, type SpaceData, type Step } from './workspace-screens.ts';

/*
 * The agent's workspace (ui-spec §8): `/agent-lab` opens it on what needs the owner — the decisions if any wait,
 * otherwise the newest result —; before the first result it walks the three steps Ситуации › Прогон › Результат.
 * Eight keys, the same everywhere: ↑↓ Enter Esc ←→ 1–3 a d ?, with silent synonyms (Tab, j/k, PgUp/PgDn, q).
 * The component only reads and navigates; everything that writes or spends goes back to the command as an action,
 * which asks the owner natively and does it through the same operations the chat uses.
 */

/** An object open on top of an area; Esc closes the innermost. */
export type Open =
  | { kind: 'situation'; id: string }
  /** A conversation the judge decided; `queue`: the owner walks the judge's decisions one after another. */
  | { kind: 'judged'; runId: string; trialId: string; queue?: string[] }
  | { kind: 'allRuns' }
  | { kind: 'run'; runId: string }
  | { kind: 'problem'; key: string };

/** Where the owner is; kept by the command across actions, so the workspace comes back to the same place. */
export interface WorkspaceState {
  /** The agent whose workspace is open; none: the folder's agents, or the start. */
  space?: string;
  area?: Area;
  step?: Step;
  stack: Open[];
  /** The cursor of each list, by the list's name. */
  selected: Record<string, number>;
  details: boolean;
  help: boolean;
  notice?: { text: string; tone: Tone };
  /** Time spent reading each judged conversation, carried into the owner's answer. */
  reading: Map<string, number>;
}
export const newState = (space?: string): WorkspaceState => ({ ...(space ? { space } : {}), stack: [], selected: {}, details: false, help: false, reading: new Map() });

/** What the workspace shows: the folder's agents, and the chosen agent's workspace when one is open. */
export interface WorkspaceView {
  agents: { space: AgentSpace; result: string | null; decisions: number }[];
  data?: SpaceData;
}

/** What the owner asked for; the command does it and opens the workspace again. */
export type WorkspaceAction =
  | { type: 'close' } | { type: 'new' } | { type: 'demo' }
  /** Open one agent's workspace from the folder's list. */
  | { type: 'space'; key: string }
  | { type: 'decide'; choice: DecisionChoice }
  | { type: 'situation'; action: SituationAction; view: SituationView; record: Experiment }
  /** Run the situations being worked on: the one run dialog; with no draft, a repeat of the newest run. */
  | { type: 'run' }
  | { type: 'stop' }
  | { type: 'report'; runId: string }
  /** `seen`: the judge's decision the owner was answering; the lab refuses when the recorded one moved meanwhile. */
  | { type: 'mark'; runId: string; trialId: string; answer: Answer; readingMs: number; seen: 'pass' | 'fail' }
  /** A question to Lab about what is selected: the command asks for one line and hands it to the conversation. */
  | { type: 'ask'; about: string; runId?: string; situation?: { number: number; id: string }; trialId?: string };

const ANSWERS: Answer[] = ['agree', 'disagree', 'unsure'];
/** The letter keys as the Russian layout types them. */
const RUSSIAN: Record<string, string> = { 'в': 'd', 'ф': 'a', 'й': 'q', 'о': 'j', 'л': 'k' };

export class LabWorkspace implements Component {
  private scroll = 0;
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private loading = false;
  private viewedTrial?: string;
  private viewedAt = performance.now();
  /** What the last render laid out: the keys act on what the owner sees. */
  private shown?: Screen & { picks?: ResultPick[] };

  constructor(private view: WorkspaceView, private readonly state: WorkspaceState, private readonly theme: Pick<Theme, 'fg' | 'bold'>,
    private readonly done: (action: WorkspaceAction) => void, private readonly redraw: () => void, private readonly rows: () => number = () => 32,
    private readonly load?: () => Promise<WorkspaceView>) {
    if (view.data && state.space && !state.area && !state.step) this.land(view.data);
    if (this.load && (view.data?.progress || view.data?.space.active)) this.timer = setInterval(() => { void this.refresh(); }, 750);
  }

  /** Where a workspace opens: the steps before the first result; after it, the decisions if any wait, else the newest result. */
  private land(data: SpaceData): void {
    if (!data.space.runs.length) this.state.step = data.progress ? 'run' : 'situations';
    else this.state.area = data.decisions.length ? 'inbox' : 'runs';
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.disposed || !this.load) return;
    this.loading = true;
    try {
      const fresh = await this.load();
      if (this.disposed) return;
      const finished = this.view.data?.progress && !fresh.data?.progress;
      this.view = fresh;
      this.frame++;
      // A first run that has just produced its result shows it; what was said about the work going on is over.
      if (finished && this.state.step) this.state.step = 'result';
      if (finished) this.state.notice = undefined;
      if (!fresh.data?.progress && !fresh.data?.space.active) { clearInterval(this.timer); this.timer = undefined; }
      this.redraw();
    } catch { /* the last snapshot stays on screen; the next tick tries again */ }
    finally { this.loading = false; }
  }

  dispose(): void { this.disposed = true; clearInterval(this.timer); }
  invalidate(): void {}

  private finish(action: WorkspaceAction): void { this.readUntil(undefined); this.dispose(); this.done(action); }

  /** Counts the time a judged conversation stays on screen, so the owner's answer carries how long it was read. */
  private readUntil(next: string | undefined): void {
    const now = performance.now();
    if (this.viewedTrial) this.state.reading.set(this.viewedTrial, Math.min(3600000, (this.state.reading.get(this.viewedTrial) ?? 0) + now - this.viewedAt));
    this.viewedTrial = next; this.viewedAt = now;
  }

  private get top(): Open | undefined { return this.state.stack.at(-1); }
  private listKey(): string {
    const top = this.top;
    if (!this.view.data) return this.view.agents.length > 1 ? 'agents' : 'start';
    if (top?.kind === 'allRuns') return 'allRuns';
    if (top) return `open:${top.kind}`;
    return this.state.step ? `step:${this.state.step}` : `area:${this.state.area}`;
  }
  private cursor(): number { return this.state.selected[this.listKey()] ?? 0; }
  private setCursor(value: number, count: number): void { this.state.selected[this.listKey()] = Math.max(0, Math.min(count - 1, value)); }

  private runOf(id: string) { return this.view.data?.runs.find(run => run.record.id === id); }
  private situation(id: string): SituationView | undefined { return this.view.data?.set?.views.find(view => view.id === id); }

  /** The screen the owner is on now, laid out for `width`. */
  private screen(width: number): Screen & { picks?: ResultPick[] } {
    const data = this.view.data && this.view.data.progress ? { ...this.view.data, progress: { ...this.view.data.progress, frame: this.frame } } : this.view.data;
    if (this.state.help) return helpScreen(width);
    if (!data) return this.view.agents.length > 1 ? agentsScreen(this.view.agents, this.cursor(), width, new Date()) : startScreen(this.cursor(), width);
    const top = this.top;
    const place = this.state.step ? { step: this.state.step } : { area: this.state.area ?? 'runs' };
    const withHead = (screen: Screen & { picks?: ResultPick[] }) => ({ ...screen, head: [...header(data, place, width), ...screen.head] });
    if (top?.kind === 'situation') {
      const view = this.situation(top.id);
      if (view) return withHead(situationScreen(view, { details: this.state.details, running: !!data.set?.running, editable: !!data.set?.editable }, width));
    }
    if (top?.kind === 'judged') {
      const run = this.runOf(top.runId);
      if (run) {
        const mark = run.view.agreement.marks.find(item => item.trialId === top.trialId && !item.stale);
        const at = top.queue ? top.queue.indexOf(top.trialId) : -1;
        return withHead(judgedScreen(run, top.trialId, mark?.answer, at >= 0 && top.queue ? { at: at + 1, of: top.queue.length } : undefined, width));
      }
    }
    if (top?.kind === 'allRuns') return withHead(allRunsScreen(data, this.cursor(), width));
    if (top?.kind === 'run') {
      const run = this.runOf(top.runId);
      if (run) return withHead(resultScreen(data, run, { selected: this.cursor(), details: this.state.details, actions: ['Отчёт для заказчика'] }, width));
    }
    if (top?.kind === 'problem') {
      const index = data.problems.findIndex(problem => problem.key === top.key);
      const problem = data.problems[index];
      if (problem) return withHead(problemScreen(problem, index + 1, width));
    }
    if (this.state.step === 'situations' || this.state.area === 'situations') return withHead(situationsScreen(data, this.cursor(), width, { firstRun: !!this.state.step }));
    if (this.state.step === 'run') return withHead(runStepScreen(data, width));
    if (this.state.area === 'inbox') return withHead(inboxScreen(data, this.cursor(), width));
    if (this.state.area === 'problems') return withHead(problemsScreen(data, this.cursor(), width));
    const latest = data.runs[0];
    if (!latest) return withHead({ head: [], body: [[{ text: ' Прогонов с результатом пока нет: запустите готовые ситуации.', tone: 'text', bold: true }]],
      foot: [{ key: '←→', text: 'области' }, { key: 'Esc', text: 'закрыть' }] });
    const screen = resultScreen(data, latest, { selected: this.cursor(), details: this.state.details, actions: this.state.step ? [] : runActions(data) }, width);
    return withHead(this.state.step ? { ...screen, foot: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: '←', text: 'прогон' }, { key: '?', text: 'клавиши' }] } : screen);
  }

  /** How many rows of the current list the cursor can move over. */
  private count(): number {
    const { data } = this.view;
    if (!data) return this.view.agents.length > 1 ? this.view.agents.length + 1 : 2;
    const top = this.top;
    if (top?.kind === 'allRuns') return data.runs.length;
    if (top?.kind === 'run' || !top && (this.state.area === 'runs' || this.state.step === 'result')) return this.shown?.picks?.length ?? 0;
    if (top) return 0;
    if (this.state.area === 'inbox') return data.decisions.length;
    if (this.state.area === 'problems') return data.problems.length;
    if (this.state.area === 'situations' || this.state.step === 'situations') return data.set?.views.length ?? 0;
    return 0;
  }

  handleInput(raw: string): void {
    if (this.disposed) return;
    // The letter keys work on the Russian layout too: the owner never has to switch it.
    const input = RUSSIAN[raw] ?? raw;
    const key = (name: Parameters<typeof matchesKey>[1]) => matchesKey(input, name);
    if (input === '?') { this.state.help = !this.state.help; this.scroll = 0; this.redraw(); return; }
    if (key('escape') || input === 'q' && !this.top && !this.state.help) {
      if (this.state.help) { this.state.help = false; }
      else if (this.top) { this.state.stack.pop(); this.state.details = false; this.scroll = 0; }
      else if (this.state.details) { this.state.details = false; }
      else return this.finish({ type: 'close' });
      this.redraw(); return;
    }
    if (key('ctrl+c')) return this.finish({ type: 'close' });
    if (this.state.help) return;
    const { data } = this.view;
    if (!data) return this.handleStart(input, key);
    if (input === 'd') { this.state.details = !this.state.details; this.scroll = 0; this.redraw(); return; }
    if (input === 'a') return this.ask(data);
    const next = key('right') || key('tab') ? 1 : key('left') || key('shift+tab') ? -1 : 0;
    if (next && !this.top) return this.move(data, next);
    const count = this.count();
    if (key('down') || input === 'j') { if (count) this.setCursor(this.cursor() + 1, count); else this.scroll++; this.redraw(); return; }
    if (key('up') || input === 'k') { if (count) this.setCursor(this.cursor() - 1, count); else this.scroll = Math.max(0, this.scroll - 1); this.redraw(); return; }
    if (key('pageDown')) { this.scroll += Math.max(1, this.rows() - 10); this.redraw(); return; }
    if (key('pageUp')) { this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 10)); this.redraw(); return; }
    if (key('home')) { this.scroll = 0; this.redraw(); return; }
    if (key('end')) { this.scroll = Number.MAX_SAFE_INTEGER; this.redraw(); return; }
    const digit = ['1', '2', '3'].indexOf(input);
    if (digit >= 0) return this.act(data, digit);
    if (key('enter')) return this.enter(data);
  }

  /** The start and the agents' list: pick one to open, or begin. */
  private handleStart(input: string, key: (name: Parameters<typeof matchesKey>[1]) => boolean): void {
    const count = this.count();
    if (key('down') || input === 'j') { this.setCursor(this.cursor() + 1, count); this.redraw(); return; }
    if (key('up') || input === 'k') { this.setCursor(this.cursor() - 1, count); this.redraw(); return; }
    if (!key('enter')) return;
    if (this.view.agents.length > 1) {
      const chosen = this.view.agents[this.cursor()];
      return this.finish(chosen ? { type: 'space', key: chosen.space.key } : { type: 'new' });
    }
    return this.finish({ type: this.cursor() === 0 ? 'new' : 'demo' });
  }

  /** ←→ go over the areas (or, before the first result, the steps). */
  private move(data: SpaceData, by: number): void {
    if (this.state.step) {
      const steps: Step[] = ['situations', 'run', 'result'];
      const next = steps[steps.indexOf(this.state.step) + by];
      if (next && (next !== 'result' || data.runs.length)) this.state.step = next;
    } else {
      const areas = areasOf(data);
      const at = Math.max(0, areas.indexOf(this.state.area ?? 'runs'));
      this.state.area = areas[(at + by + areas.length) % areas.length];
    }
    this.scroll = 0; this.state.details = false; this.redraw();
  }

  /** Enter: open what is selected, or do what the line says. */
  private enter(data: SpaceData): void {
    const top = this.top;
    const cursor = this.cursor();
    if (top?.kind === 'allRuns') { const run = data.runs[cursor]; if (run) this.open({ kind: 'run', runId: run.record.id }); return; }
    if (top?.kind === 'run' || !top && (this.state.area === 'runs' || this.state.step === 'result')) {
      const run = top?.kind === 'run' ? this.runOf(top.runId) : data.runs[0];
      const pick = this.shown?.picks?.[cursor];
      if (!run || !pick) return;
      if (pick.kind === 'failure') return this.open({ kind: 'judged', runId: run.record.id, trialId: pick.trialId });
      const queue = run.view.agreement.unmarked;
      if (queue[0]) this.open({ kind: 'judged', runId: run.record.id, trialId: queue[0], queue });
      return;
    }
    if (top) return;
    if (this.state.step === 'run') {
      if (data.progress?.stoppable) return this.finish({ type: 'stop' });
      if (!data.progress && data.set?.plan.situations) return this.finish({ type: 'run' });
      return;
    }
    if (this.state.area === 'inbox') {
      // Enter opens what the decision is about: its situation, else the first thing it offers to open.
      const decision = data.decisions[cursor];
      const about = decision?.choices.map(choice => choice.action).find(action => action.kind === 'answer' || action.kind === 'remove' || action.kind === 'add_rule');
      const situation = about && 'situation' in about ? data.set?.views.find(view => view.number === about.situation) : undefined;
      if (situation) this.open({ kind: 'situation', id: situation.id });
      else for (const choice of decision?.choices ?? []) if (this.navigate(data, choice.action)) return;
      return;
    }
    if (this.state.area === 'problems') { const problem = data.problems[cursor]; if (problem) this.open({ kind: 'problem', key: problem.key }); return; }
    const view = data.set?.views[cursor];
    if (view) this.open({ kind: 'situation', id: view.id });
  }

  /** 1–3: the one row of actions on the screen — the answer to its question or what the selected object can do. */
  private act(data: SpaceData, digit: number): void {
    const top = this.top;
    if (top?.kind === 'judged') {
      const run = this.runOf(top.runId);
      const target = run && agreementTarget(run.record, run.record.trials.find(trial => trial.id === top.trialId));
      // Only a decision the judge made can be answered; the screen says why otherwise.
      if (target?.kind !== 'ready') return;
      return this.finish({ type: 'mark', runId: top.runId, trialId: top.trialId, answer: ANSWERS[digit]!, readingMs: Math.round(this.state.reading.get(top.trialId) ?? 0), seen: target.judgeVerdict });
    }
    if (top?.kind === 'problem') {
      const problem = data.problems.find(item => item.key === top.key);
      if (digit === 0 && problem?.trialId) this.open({ kind: 'judged', runId: problem.runId, trialId: problem.trialId });
      return;
    }
    if (top?.kind === 'run') { if (digit === 0) this.finish({ type: 'report', runId: top.runId }); return; }
    if (top?.kind === 'situation') {
      const view = this.situation(top.id);
      const action = view && data.set?.editable ? situationActions(view)[digit] : undefined;
      if (view && action && data.set) this.finish({ type: 'situation', action, view, record: data.set.record });
      return;
    }
    if (top) return;
    const cursor = this.cursor();
    if (this.state.area === 'inbox') {
      const choice = data.decisions[cursor]?.choices[digit];
      if (!choice) return;
      if (choice.settles || !this.navigate(data, choice.action)) this.finish({ type: 'decide', choice });
      return;
    }
    if (this.state.area === 'situations' || this.state.step === 'situations') {
      const view = data.set?.views[cursor];
      const action = view && data.set?.editable ? situationActions(view)[digit] : undefined;
      if (view && action && data.set) this.finish({ type: 'situation', action, view, record: data.set.record });
      return;
    }
    if (this.state.area === 'problems') {
      const problem = data.problems[cursor];
      if (digit === 0 && problem?.trialId) this.open({ kind: 'judged', runId: problem.runId, trialId: problem.trialId });
      return;
    }
    if (this.state.area === 'runs' && !this.state.step) {
      const latest = data.runs[0];
      if (digit === 0 && latest) return this.finish({ type: 'report', runId: latest.record.id });
      if (digit === 1) return this.finish({ type: 'run' });
      if (digit === 2) this.open({ kind: 'allRuns' });
    }
  }

  /** Opens what a decision points at, inside the workspace; false when the choice needs the command (the conversation, a write). */
  private navigate(data: SpaceData, action: DecisionChoice['action']): boolean {
    switch (action.kind) {
      case 'open_situations': this.state.area = 'situations'; this.state.stack = []; this.redraw(); return true;
      case 'open_situation': {
        const view = data.set?.views.find(item => item.id === action.scenarioId);
        if (!view) return false;
        this.open({ kind: 'situation', id: view.id });
        return true;
      }
      case 'open_conversation': this.open({ kind: 'judged', runId: action.runId, trialId: action.trialId }); return true;
      default: return false;
    }
  }

  private open(object: Open): void {
    this.state.stack.push(object);
    this.state.details = false; this.scroll = 0; this.redraw();
  }

  /** a: a question to Lab about what is selected. */
  private ask(data: SpaceData): void {
    const top = this.top;
    const cursor = this.cursor();
    const view = top?.kind === 'situation' ? this.situation(top.id) : !top && (this.state.area === 'situations' || this.state.step === 'situations') ? data.set?.views[cursor] : undefined;
    if (view) return this.finish({ type: 'ask', about: `ситуацию ${view.number} «${view.brief.title}»`, ...(data.set ? { runId: data.set.record.id } : {}), situation: { number: view.number, id: view.id } });
    if (top?.kind === 'judged') {
      const run = this.runOf(top.runId);
      const title = run?.record.scenarios.find(item => item.id === run.record.trials.find(trial => trial.id === top.trialId)?.scenarioId)?.title ?? '';
      return this.finish({ type: 'ask', about: `разговор «${title}»`, runId: top.runId, trialId: top.trialId });
    }
    if (top?.kind === 'problem') {
      const problem = data.problems.find(item => item.key === top.key);
      return this.finish({ type: 'ask', about: `проблему «${problem?.title ?? ''}»`, ...(problem ? { runId: problem.runId } : {}) });
    }
    if (!top && this.state.area === 'inbox') {
      const decision = data.decisions[cursor];
      if (decision) return this.finish({ type: 'ask', about: `решение «${decision.subject}: ${decision.text}»`, ...(data.set ? { runId: data.set.record.id } : {}) });
    }
    const run = top?.kind === 'run' ? this.runOf(top.runId) : data.runs[0];
    return this.finish({ type: 'ask', about: run ? 'результат прогона' : 'ситуации агента', ...(run ? { runId: run.record.id } : data.set ? { runId: data.set.record.id } : {}) });
  }

  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(6, this.rows());
    const screen = this.screen(width);
    this.shown = screen;
    const top = this.top;
    this.readUntil(top?.kind === 'judged' ? top.trialId : undefined);
    const paint = (line: Line) => line.map(part => {
      const text = part.bold ? this.theme.bold(part.text) : part.text;
      return part.tone ? this.theme.fg(part.tone, text) : text;
    }).join('');
    const notice = this.state.notice;
    // What the last action did is said whole: it wraps under the header instead of being cut.
    const said = notice ? wrapTextWithAnsi(notice.text, Math.max(10, Math.min(width, MAX_WIDTH) - 1)).map((text): Line => [{ text: ` ${text}`, tone: notice.tone }]) : [];
    const head = [...screen.head, ...said];
    const foot = this.footer(screen.foot, width);
    const border = this.theme.fg('borderMuted', '─'.repeat(width));
    // Two lines, the blank ones between the blocks and the footer are fixed; the body scrolls in the rest.
    const room = Math.max(1, height - head.length - foot.length - 4);
    const body = screen.body;
    const anchor = screen.anchor;
    const maxScroll = Math.max(0, body.length - room);
    if (anchor !== undefined && (screen.items?.length ?? 0) > 0) {
      // A list keeps the selected item in view, with the next one peeking in below when there is room.
      if (anchor < this.scroll) this.scroll = anchor;
      const end = (screen.items?.find(start => start > anchor) ?? body.length) - 1;
      if (end >= this.scroll + room) this.scroll = Math.min(anchor, end - room + 1);
    }
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    let visible = body.slice(this.scroll, this.scroll + room);
    const hidden = (screen.items ?? []).filter(start => start >= this.scroll + room).length;
    if (body.length > this.scroll + room) {
      const mark = hidden ? `↓ ещё ${hidden}` : '↓ ниже есть ещё';
      visible = [...visible.slice(0, -1), [{ text: `${' '.repeat(Math.max(1, Math.min(width, 100) - visibleWidth(mark) - 1))}${mark}`, tone: 'muted' }]];
    }
    const filler = Array.from({ length: Math.max(0, room - visible.length) }, () => '');
    const lines = [border, ...head.map(paint), '', ...visible.map(paint), ...filler, '', ...foot, border];
    return lines.slice(0, height).map(line => visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line);
  }

  /** One row of key hints: the key dim, what it does muted (ui-spec §5); never more than five keys. */
  private footer(hints: Hint[], width: number): string[] {
    const text = hints.slice(0, 5).map(hint => `${this.theme.fg('dim', hint.key)} ${this.theme.fg('muted', hint.text)}`).join(this.theme.fg('muted', ' · '));
    return [` ${text}`].map(line => visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line);
  }
}

export function showWorkspace(ctx: ExtensionContext, view: WorkspaceView, state: WorkspaceState, load?: () => Promise<WorkspaceView>): Promise<WorkspaceAction> {
  return ctx.ui.custom<WorkspaceAction>((tui, theme, _keys, done) =>
    new LabWorkspace(view, state, theme, done, () => tui.requestRender(), () => tui.terminal.rows, load),
  { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
