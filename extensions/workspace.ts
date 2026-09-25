import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { MAX_WIDTH } from '../src/result-text.js';
import { WORKSPACE_WIDTH } from './preparation-panel.ts';
import type { Experiment } from '../src/contracts.js';
import { logTargets } from '../src/card/calibration-view.js';
import { situationActions, type SituationAction, type SituationView } from '../src/card/view.js';
import type { DecisionChoice } from '../src/inbox.js';
import type { AgentSpace } from '../src/workspace.js';
import { agreementTarget, seenVerdicts, type Answer } from './judge-review.ts';
import { GLYPH, type Tone } from './render/theme.ts';
import { agentsScreen, allRunsScreen, areasOf, header, helpScreen, inboxScreen, judgedScreen, logScreen, NARROW, problemScreen, problemsScreen, resultPicks, resultScreen, rulebookScreen, runActions,
  runStepScreen, situationScreen, situationsScreen, startScreen, type Area, type Hint, type Line, type ResultPick, type Screen, type SpaceData, type Step } from './workspace-screens.ts';

/*
 * The agent's workspace (docs/design/ui-spec.md §8): `/agent-lab` opens it on what needs the owner — the decisions if any wait,
 * otherwise the newest result —; before the first result it walks the three steps Ситуации › Прогон › Результат.
 * Eight keys, the same everywhere: ↑↓ Enter Esc ←→ 1–3 a d ?, with silent synonyms (Tab, j/k, PgUp/PgDn, Home/End, q).
 * The component only reads and navigates; everything that writes or spends goes back to the command as an action,
 * which asks the owner natively and does it through the same operations the chat uses.
 *
 * What it points at is read again with every snapshot: an open object that is gone closes, a cursor past the end of its
 * list stands on the last row. A body taller than the screen scrolls in a window that keeps the selection above
 * «↓ ещё N»; the page keys move the window alone until ↑↓ moves the selection again.
 */

/** An object open on top of an area; Esc closes the innermost. */
export type Open =
  | { kind: 'situation'; id: string }
  /** A conversation the judge decided; `queue`: the owner walks the judge's decisions one after another. */
  | { kind: 'judged'; runId: string; trialId: string; queue?: string[] }
  /** A situation of a run that disagrees with production: the judge's reading of its logged conversation is answered here. */
  | { kind: 'log'; runId: string; cardId: string }
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
  /** «Свод правил»: operator instructions bind the bot as a whole, or not; the command asks the owner natively. */
  | { type: 'rulebook'; record: Experiment; operatorInstructions: boolean }
  /** Run the situations being worked on: the one run dialog; with no draft, a repeat of the newest run. */
  | { type: 'run' }
  | { type: 'stop' }
  | { type: 'report'; runId: string }
  /** `seen`: the judge's decision the owner was answering; the lab refuses when the recorded one moved meanwhile. */
  | { type: 'mark'; runId: string; trialId: string; answer: Answer; readingMs: number; seen: 'pass' | 'fail' }
  /** The same about the judge's reading of a situation's logged conversation; `seen`: its verdicts the owner was shown, by receipt. */
  | { type: 'mark_log'; runId: string; cardId: string; answer: Answer; seen: Record<string, 'pass' | 'fail'> }
  /** A question to Lab about what is selected: the command asks for one line and hands it to the conversation. */
  | { type: 'ask'; about: string; runId?: string; situation?: { number: number; id: string }; trialId?: string };

const ANSWERS: Answer[] = ['agree', 'disagree', 'unsure'];
/** How often the spinner of work going on turns: the pace of Pi's own Loader, so the chat and the workspace turn alike. */
const SPIN_MS = 80;
/** The letter keys as the Russian layout types them. */
const RUSSIAN: Record<string, string> = { 'в': 'd', 'ф': 'a', 'й': 'q', 'о': 'j', 'л': 'k' };

/**
 * How an open workspace hears that what it shows has changed: `changed` is called at every change — a record written
 * by this session or another, a new progress line of this session's work — until the returned stop is called.
 */
export type WorkspaceChanges = (changed: () => void) => () => void;

export class LabWorkspace implements Component {
  private scroll = 0;
  /** PgUp/PgDn, Home or End moved the window: it stays where they put it until ↑↓ moves the selection again. */
  private free = false;
  private frame = 0;
  private unfollow?: () => void;
  private spinning?: ReturnType<typeof setInterval>;
  private disposed = false;
  private loading = false;
  /** A change came while the workspace was reading itself: it reads itself once more when that read ends. */
  private stale = false;
  private viewedTrial?: string;
  private viewedAt = performance.now();

  constructor(private view: WorkspaceView, private readonly state: WorkspaceState, private readonly theme: Pick<Theme, 'fg' | 'bold'> & Partial<Pick<Theme, 'bg'>>,
    private readonly done: (action: WorkspaceAction) => void, private readonly redraw: () => void, private readonly rows: () => number = () => 32,
    private readonly load?: () => Promise<WorkspaceView>, changes?: WorkspaceChanges) {
    if (view.data && state.space && !state.area && !state.step) this.land(view.data);
    this.reconcile();
    // Work going on is followed, not polled: the workspace reads itself again when the work reports a change. Only its
    // spinner turns on a clock, and that clock draws — it never reads.
    if (this.load && changes && (view.data?.progress || view.data?.space.active)) {
      this.unfollow = changes(() => this.changed());
      this.spinning = setInterval(() => { this.frame++; this.redraw(); }, SPIN_MS);
    }
  }

  /**
   * Where a workspace opens: the steps before the first result — a run going on on its own step, situations being
   * prepared or checked where they appear —; after it, the decisions if any wait, else the newest result.
   */
  private land(data: SpaceData): void {
    if (!data.space.runs.length) this.state.step = data.progress?.kind === 'run' ? 'run' : 'situations';
    else this.state.area = data.decisions.length ? 'inbox' : 'runs';
  }

  /**
   * What the workspace points at is read again with every snapshot: an open object that is gone — a situation taken
   * out of the draft, a problem that no longer repeats — closes, down to what is still there. Cursors are held to their
   * lists as they are read (`cursor`).
   */
  private reconcile(): void {
    const data = this.view.data;
    const kept = data ? this.state.stack.filter(open => stillThere(data, open)) : [];
    if (kept.length === this.state.stack.length) return;
    this.state.stack = kept;
    this.state.details = false;
    this.home();
  }

  private changed(): void {
    if (this.loading) this.stale = true;
    else void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.disposed || !this.load) return;
    this.loading = true;
    try {
      const fresh = await this.load();
      if (this.disposed) return;
      const ended = fresh.data?.progress ? undefined : this.view.data?.progress?.kind;
      this.view = fresh;
      // Work that has just ended shows what it made — a first run its result, a preparation or a check the situations —;
      // what was said about the work going on is over.
      if (ended && this.state.step) this.state.step = ended !== 'run' ? 'situations' : fresh.data?.runs.length ? 'result' : this.state.step;
      if (ended) this.state.notice = undefined;
      this.reconcile();
      if (!fresh.data?.progress && !fresh.data?.space.active) this.stopFollowing();
      this.redraw();
    } catch { /* the last snapshot stays on screen; the next change tries again */ }
    finally {
      this.loading = false;
      if (this.stale && !this.disposed) { this.stale = false; void this.refresh(); }
    }
  }

  private stopFollowing(): void { this.unfollow?.(); this.unfollow = undefined; clearInterval(this.spinning); this.spinning = undefined; }
  dispose(): void { this.disposed = true; this.stopFollowing(); }
  invalidate(): void {}

  private finish(action: WorkspaceAction): void { this.readUntil(undefined); this.dispose(); this.done(action); }

  /**
   * Counts the time a judged conversation stays on screen, so the owner's answer carries how long it was read. The
   * screen is drawn only when something changes, so the time is taken at every draw and at the key that answers.
   */
  private readUntil(next: string | undefined): void {
    const now = performance.now();
    if (this.viewedTrial) this.state.reading.set(this.viewedTrial, Math.min(3600000, (this.state.reading.get(this.viewedTrial) ?? 0) + now - this.viewedAt));
    this.viewedTrial = next; this.viewedAt = now;
  }

  /** The top of the body, with the window following the selection again. */
  private home(): void { this.scroll = 0; this.free = false; }

  private get top(): Open | undefined { return this.state.stack.at(-1); }
  private listKey(): string {
    const top = this.top;
    if (!this.view.data) return this.view.agents.length > 1 ? 'agents' : 'start';
    if (top?.kind === 'allRuns') return 'allRuns';
    if (top) return `open:${top.kind}`;
    return this.state.step ? `step:${this.state.step}` : `area:${this.state.area}`;
  }
  /** The cursor of the current list, held to the list as it is now: one that got shorter keeps it on its last row. */
  private cursor(): number {
    const key = this.listKey();
    const stored = this.state.selected[key] ?? 0;
    const held = Math.max(0, Math.min(stored, this.count() - 1));
    if (held !== stored) this.state.selected[key] = held;
    return held;
  }
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
    const withHead = (screen: Screen & { picks?: ResultPick[] }) => ({ ...screen, head: [...header(data, place, width, this.rows() < 28), ...screen.head] });
    if (top?.kind === 'situation') {
      const view = this.situation(top.id);
      if (view) return withHead(situationScreen(view, { details: this.state.details, running: !!data.set?.running, editable: !!data.set?.editable }, width));
    }
    if (top?.kind === 'judged') {
      const run = this.runOf(top.runId);
      if (run) {
        const mark = run.view.agreement.marks.find(item => item.trialId === top.trialId && !item.stale);
        const at = top.queue ? top.queue.indexOf(top.trialId) : -1;
        return withHead(judgedScreen(run, top.trialId, mark?.answer, at >= 0 && top.queue ? { at: at + 1, of: top.queue.length } : undefined, width, this.state.details));
      }
    }
    if (top?.kind === 'log') {
      const run = this.runOf(top.runId);
      if (run) return withHead(logScreen(data, run, top.cardId, width));
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
    if (this.state.step === 'run') return withHead(runStepScreen(data, width, this.state.details));
    if (this.state.area === 'inbox') return withHead(inboxScreen(data, this.cursor(), width));
    if (this.state.area === 'rules') return withHead(rulebookScreen(data, width));
    if (this.state.area === 'problems') return withHead(problemsScreen(data, this.cursor(), width));
    const latest = data.runs[0];
    if (!latest) return withHead({ head: [], body: [[{ text: ' Прогонов с результатом пока нет: запустите готовые ситуации.', tone: 'text', bold: true }]],
      foot: [{ key: '←→', text: 'области' }, { key: 'Esc', text: 'закрыть' }] });
    const screen = resultScreen(data, latest, { selected: this.cursor(), details: this.state.details, actions: this.state.step ? [] : runActions(data) }, width);
    return withHead(this.state.step ? { ...screen, foot: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'd', text: this.state.details ? 'к сводке' : 'подробности' }, { key: '←', text: 'прогон' }, { key: '?', text: 'клавиши' }] } : screen);
  }

  /** The run a result screen shows: the one opened from «Все прогоны», else the newest. */
  private shownRun(): SpaceData['runs'][number] | undefined {
    const top = this.top;
    return top?.kind === 'run' ? this.runOf(top.runId) : !top && (this.state.area === 'runs' || this.state.step === 'result') ? this.view.data?.runs[0] : undefined;
  }

  /** How many rows of the current list the cursor can move over, read from the data itself — never from the last drawing. */
  private count(): number {
    const { data } = this.view;
    if (!data) return this.view.agents.length > 1 ? this.view.agents.length + 1 : 2;
    const top = this.top;
    if (top?.kind === 'allRuns') return data.runs.length;
    if (top?.kind === 'run' || !top && (this.state.area === 'runs' || this.state.step === 'result')) {
      const run = this.shownRun();
      return run ? resultPicks(run.view, data.now, this.state.details).length : 0;
    }
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
    if (input === '?') { this.state.help = !this.state.help; this.home(); this.redraw(); return; }
    if (key('escape') || input === 'q' && !this.top && !this.state.help) {
      if (this.state.help) { this.state.help = false; }
      else if (this.top) { this.state.stack.pop(); this.state.details = false; this.home(); }
      else if (this.state.details) { this.state.details = false; }
      else return this.finish({ type: 'close' });
      this.redraw(); return;
    }
    if (key('ctrl+c')) return this.finish({ type: 'close' });
    if (this.state.help) return;
    const { data } = this.view;
    if (!data) return this.handleStart(input, key);
    if (input === 'd') { this.state.details = !this.state.details; this.state.selected[this.listKey()] = 0; this.home(); this.redraw(); return; }
    if (input === 'a') return this.ask(data);
    const next = key('right') || key('tab') ? 1 : key('left') || key('shift+tab') ? -1 : 0;
    if (next && !this.top) return this.move(data, next);
    const count = this.count();
    // ↑↓ move the selection, and the window follows it again; the page keys move only the window, and let it go.
    if (key('down') || input === 'j') { this.free = false; if (count) this.setCursor(this.cursor() + 1, count); else this.scroll++; this.redraw(); return; }
    if (key('up') || input === 'k') { this.free = false; if (count) this.setCursor(this.cursor() - 1, count); else this.scroll = Math.max(0, this.scroll - 1); this.redraw(); return; }
    if (key('pageDown')) { this.free = true; this.scroll += Math.max(1, this.rows() - 10); this.redraw(); return; }
    if (key('pageUp')) { this.free = true; this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 10)); this.redraw(); return; }
    if (key('home')) { this.free = true; this.scroll = 0; this.redraw(); return; }
    if (key('end')) { this.free = true; this.scroll = Number.MAX_SAFE_INTEGER; this.redraw(); return; }
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
    this.home(); this.state.details = false; this.redraw();
  }

  /** Enter: open what is selected, or do what the line says. */
  private enter(data: SpaceData): void {
    const top = this.top;
    const cursor = this.cursor();
    if (top?.kind === 'allRuns') { const run = data.runs[cursor]; if (run) this.open({ kind: 'run', runId: run.record.id }); return; }
    if (top?.kind === 'run' || !top && (this.state.area === 'runs' || this.state.step === 'result')) {
      const run = this.shownRun();
      const pick = run && resultPicks(run.view, data.now, this.state.details)[cursor];
      if (run && pick) this.take(run, pick);
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

  /** Enter on a row of a result: a cause opens its failure; a step of «Дальше» does what it says. */
  private take(run: SpaceData['runs'][number], pick: ResultPick): void {
    switch (pick.kind) {
      case 'failure': return this.open({ kind: 'judged', runId: run.record.id, trialId: pick.trialId });
      case 'log': return this.open({ kind: 'log', runId: run.record.id, cardId: pick.cardId });
      case 'review': {
        const queue = run.view.agreement.unmarked;
        if (queue[0]) this.open({ kind: 'judged', runId: run.record.id, trialId: queue[0], queue });
        return;
      }
      case 'report': return this.finish({ type: 'report', runId: run.record.id });
      case 'repeat': return this.finish({ type: 'run' });
      // The unmeasured situations and their reasons are in the details of the same screen.
      case 'unmeasured': this.state.details = true; this.state.selected[this.listKey()] = 0; this.home(); this.redraw(); return;
      case 'connection': return this.finish({ type: 'decide', choice: { label: 'Проверить связь с агентом', action: { kind: 'check_connection' }, settles: false } });
    }
  }

  /** 1–3: the one row of actions on the screen — the answer to its question or what the selected object can do. */
  private act(data: SpaceData, digit: number): void {
    const top = this.top;
    if (top?.kind === 'judged') {
      const run = this.runOf(top.runId);
      const target = run && agreementTarget(run.record, run.record.trials.find(trial => trial.id === top.trialId));
      // Only a decision the judge made can be answered; the screen says why otherwise.
      if (target?.kind !== 'ready') return;
      // The conversation was read until this key, whether or not the screen was drawn again meanwhile.
      this.readUntil(top.trialId);
      return this.finish({ type: 'mark', runId: top.runId, trialId: top.trialId, answer: ANSWERS[digit]!, readingMs: Math.round(this.state.reading.get(top.trialId) ?? 0), seen: target.judgeVerdict });
    }
    if (top?.kind === 'log') {
      const run = this.runOf(top.runId);
      // Only verdicts the judge gave on the log can be answered; the screen says why otherwise.
      const targets = run ? logTargets(run.record, top.cardId) : [];
      if (!targets.length) return;
      return this.finish({ type: 'mark_log', runId: top.runId, cardId: top.cardId, answer: ANSWERS[digit]!, seen: seenVerdicts(targets) });
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
    if (this.state.area === 'rules') {
      const operators = data.set?.rulebook?.kinds.find(item => item.kind === 'operator_procedure');
      if (digit === 0 && operators && data.set?.editable) this.finish({ type: 'rulebook', record: data.set.record, operatorInstructions: !operators.binds });
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
      case 'open_situations': this.state.area = 'situations'; this.state.stack = []; this.home(); this.redraw(); return true;
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
    this.state.details = false; this.home(); this.redraw();
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
    if (top?.kind === 'log') {
      const item = this.runOf(top.runId)?.view.calibration?.disagreements.find(entry => entry.cardId === top.cardId);
      return this.finish({ type: 'ask', about: `сверку с продом ситуации ${item?.number ?? ''} «${item?.title ?? ''}»`, runId: top.runId });
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
    const terminalWidth = width;
    width = Math.min(width, WORKSPACE_WIDTH);
    const margin = ' '.repeat(Math.max(0, Math.floor((terminalWidth - width) / 2)));
    const height = Math.max(6, this.rows());
    const screen = this.screen(width);
    const top = this.top;
    this.readUntil(top?.kind === 'judged' ? top.trialId : undefined);
    const paint = (line: Line) => line.map(part => {
      const text = part.bold ? this.theme.bold(part.text) : part.text;
      const foreground = part.tone ? this.theme.fg(part.tone, text) : text;
      return part.background && this.theme.bg ? this.theme.bg(part.background, foreground) : foreground;
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
    const items = screen.items ?? [];
    // A body taller than the room ends in «↓ ещё N» until the window reaches its end. That row is kept before the window
    // is placed, so the mark never stands where the selection is.
    const window = body.length > room ? Math.max(1, room - 1) : room;
    const maxScroll = Math.max(0, body.length - room);
    if (!this.free && screen.anchor !== undefined && items.length) {
      // A list keeps the selected item whole in view — from its first line, when it is taller than the window.
      const anchor = screen.anchor;
      const end = (items.find(start => start > anchor) ?? anchor + 1) - 1;
      if (anchor < this.scroll) this.scroll = anchor;
      if (end >= this.scroll + window) this.scroll = Math.min(anchor, end - window + 1);
    }
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const more = body.length > this.scroll + room;
    let visible = body.slice(this.scroll, this.scroll + (more ? window : room));
    if (more) {
      // What is below: the items that start under the window, every one of them counted.
      const hidden = items.filter(start => start >= this.scroll + window).length;
      const mark = hidden ? `${GLYPH.more} ещё ${hidden}` : `${GLYPH.more} ниже есть ещё`;
      visible = [...visible, [{ text: `${' '.repeat(Math.max(1, Math.min(width, MAX_WIDTH) - visibleWidth(mark) - 1))}${mark}`, tone: 'muted' }]];
    }
    const filler = Array.from({ length: Math.max(0, room - visible.length) }, () => '');
    const lines = [border, ...head.map(paint), '', ...visible.map(paint), ...filler, '', ...foot, border];
    return lines.slice(0, height).map(line => margin + (visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line));
  }

  /**
   * One row of key hints: the key dim, what it does muted (docs/design/ui-spec.md §5), never more than five keys and never
   * cut — a hint that does not fit gives way whole, and the last one, the way to every key or out, stays. Narrower
   * than 50 columns only that way stays: «? клавиши · Esc …» (§6).
   */
  private footer(hints: Hint[], width: number): string[] {
    // Esc goes back from anything open; at the top of an area it closes the board.
    const out = hints.find(hint => hint.key === 'Esc') ?? { key: 'Esc', text: this.top || this.state.details || this.state.help ? 'назад' : 'закрыть' };
    let shown = width < NARROW ? [...(this.state.help ? [] : [{ key: '?', text: 'клавиши' }]), out] : hints.slice(0, 5);
    const plain = (list: readonly Hint[]) => ` ${list.map(hint => `${hint.key} ${hint.text}`).join(' · ')}`;
    while (shown.length > 1 && visibleWidth(plain(shown)) > width) shown = [...shown.slice(0, -2), shown.at(-1)!];
    const text = shown.map(hint => `${this.theme.bold(this.theme.fg('accent', hint.key))} ${this.theme.fg('muted', hint.text)}`).join(this.theme.fg('muted', ' · '));
    return [` ${text}`].map(line => visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line);
  }
}

/** Whether what an open object names is still in the workspace's snapshot. */
function stillThere(data: SpaceData, open: Open): boolean {
  switch (open.kind) {
    case 'situation': return !!data.set?.views.some(view => view.id === open.id);
    case 'judged': return !!data.runs.find(run => run.record.id === open.runId)?.record.trials.some(trial => trial.id === open.trialId);
    // A situation the owner's answer brought into agreement with production has nothing left to open.
    case 'log': return !!data.runs.find(run => run.record.id === open.runId)?.view.calibration?.disagreements.some(item => item.cardId === open.cardId);
    case 'allRuns': return data.runs.length > 0;
    case 'run': return data.runs.some(run => run.record.id === open.runId);
    case 'problem': return data.problems.some(problem => problem.key === open.key);
  }
}

export function showWorkspace(ctx: ExtensionContext, view: WorkspaceView, state: WorkspaceState, load?: () => Promise<WorkspaceView>, changes?: WorkspaceChanges): Promise<WorkspaceAction> {
  return ctx.ui.custom<WorkspaceAction>((tui, theme, _keys, done) =>
    new LabWorkspace(view, state, theme, done, () => tui.requestRender(), () => tui.terminal.rows, load, changes),
  { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
