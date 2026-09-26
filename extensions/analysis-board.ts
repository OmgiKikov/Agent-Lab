import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { LogAnalysis } from '../src/discover/schema.js';
import { analysisLines, conversationLines, exampleLine, headline, nextStep, problemSize, problemTitle, reviewWord } from '../src/discover/text.js';
import type { AnalysisView } from '../src/discover/view.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import { clip, safeLine, safeText } from '../src/text.js';
import { WORKSPACE_WIDTH } from './preparation-panel.ts';
import { GLYPH, type Tone } from './render/theme.ts';

/*
 * «Разборы логов» in /agent-lab (DISCOVER on its own): every analysis of the folder, newest first, each reachable after a
 * newer one — no card, no run, no agent needed. From an analysis to a problem, to an example, to the whole logged
 * conversation it came from; on an example the owner's key is their word on the judge's finding (1 нарушение есть,
 * 2 не нарушение, 3 не знаю), which the command records — a dispute with the owner's reason, asked natively — and the
 * example shows the mark it holds. The words are discover/text.ts's; the component only reads and navigates.
 *
 *   list ──Enter──► analysis ──Enter──► problem ──Enter──► example: evidence, the judge's reason, the mark, the conversation
 *                                                           └─ 1 2 3 ──► the command records the owner's word ──► back here
 */

/** One analysis as the board shows it: the record, its view, and its import when it still reads. */
export interface AnalysisEntry { analysis: LogAnalysis; view: AnalysisView; batch?: ImportBatch }
export interface AnalysisBoardView { entries: AnalysisEntry[] }

/** What is open, innermost last; the command keeps it across actions, so the board comes back to the same place. */
export type AnalysisFrame = { kind: 'analysis'; id: string } | { kind: 'problem'; id: string; key: string } | { kind: 'example'; id: string; key: string; finding: string }
  | { kind: 'factConversation'; id: string; dialogueId: string };
export interface AnalysisBoardState { stack: AnalysisFrame[]; selected: Record<string, number>; notice?: { text: string; tone: Tone } }
export const newAnalysisState = (open?: { id: string; problemKey?: string }): AnalysisBoardState => ({
  stack: open ? [{ kind: 'analysis', id: open.id }, ...(open.problemKey ? [{ kind: 'problem' as const, id: open.id, key: open.problemKey }] : [])] : [], selected: {} });

export type AnalysisAction = { type: 'back' } | { type: 'close' } | { type: 'review'; analysisId: string; key: string; verdict: 'confirmed' | 'disputed' | 'unsure' };

type Row = { text: string; tone?: Tone; bold?: boolean; indent?: number };
interface Screen { head: Row[]; body: Row[]; /** Body rows that are items, in order; the selected one is kept in view. */ items: number[]; foot: string }

const VERDICTS = ['confirmed', 'disputed', 'unsure'] as const;
/** The problems of an analysis the board lists and opens: the counted ones, then those the owner disputed whole — with their marks. */
const listed = (view: AnalysisView) => [...view.problems, ...view.overruled];
const when = (iso: string): string => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** The list of the folder's analyses. */
function listScreen(entries: readonly AnalysisEntry[], selected: number): Screen {
  const body: Row[] = [];
  const items: number[] = [];
  if (!entries.length) body.push({ text: 'В этой папке пока нет разборов. В чате укажите файл логов и материалы, по которым проверить ответы.', tone: 'muted' });
  entries.forEach(({ analysis, view }, index) => {
    items.push(body.length);
    const mine = index === selected;
    body.push({ text: `${mine ? GLYPH.selected : ' '} ${when(analysis.createdAt)} · «${clip(view.file, 40)}»${analysis.continues ? ' · продолжение' : ''}`, bold: mine, tone: 'text' });
    body.push({ text: headline(view), tone: view.problems.length ? 'warning' : 'muted', indent: 3 });
  });
  return { head: [{ text: 'Разборы логов', bold: true }, { text: 'Что агент делал с настоящими клиентами по вашим правилам — без ситуаций и без запуска агента.', tone: 'muted' }],
    body, items, foot: '↑↓ выбрать · Enter открыть · Esc назад' };
}

/** One analysis: the answer, its problems to open, then what it covers and does not say. */
function analysisScreen(entry: AnalysisEntry, selected: number): Screen {
  const { view } = entry;
  const lines = analysisLines(view, { examples: 0, problems: 0 });
  const body: Row[] = [];
  const items: number[] = [];
  const unfinished = lines.find(line => line.startsWith('Разбор не закончен:'));
  if (unfinished) body.push({ text: unfinished, tone: 'warning' });
  if (view.problems.length) body.push({ text: 'Возможные нарушения по оценке судьи:', tone: 'accent', bold: true });
  listed(view).forEach((problem, index) => {
    if (index === view.problems.length) body.push({ text: 'Вы оспорили все примеры — не считаются, ваши отметки сохранены:', tone: 'muted', bold: true });
    items.push(body.length);
    const mine = index === selected;
    body.push({ text: `${mine ? GLYPH.selected : ' '} ${index + 1}. ${problemTitle(problem)} — ${problem.violations ? problemSize(problem) : `вы оспорили ${problem.disputed}`}${problem.knowledgeOnly ? ' · по базе знаний, требуется ваша оценка' : ''}`, bold: mine });
  });
  if (view.checking === 'facts' && entry.analysis.factChecks?.length) {
    body.push({ text: '' }, { text: 'Проверенные разговоры — откройте, чтобы увидеть утверждения и источники:', tone: 'accent', bold: true });
    entry.analysis.factChecks.forEach((check, index) => {
      const at = listed(view).length + index;
      const summary = check.complete ? `подтверждено ${check.claims.filter(claim => claim.result === 'supported').length}, возможных противоречий ${check.claims.filter(claim => claim.result === 'contradicted').length}, без вывода ${check.claims.filter(claim => claim.result === 'unknown').length}`
        : check.issue ? 'проверка не завершена' : 'проверяется';
      items.push(body.length);
      body.push({ text: `${at === selected ? GLYPH.selected : ' '} Разговор ${index + 1}: ${summary}`, bold: at === selected },
        { text: check.question, tone: 'muted', indent: 3 });
    });
  }
  // The rest of the answer as analysisLines words it, without the headline and the problems shown above.
  const rest = lines.slice(1).filter(line => line !== unfinished);
  body.push({ text: '' }, ...rest.map((text): Row => ({ text, tone: text.startsWith('Отдельный сигнал:') ? 'warning' : 'muted' })), { text: '' }, { text: nextStep(view), tone: 'muted' });
  return { head: [{ text: headline(view), bold: true, tone: view.problems.length ? 'warning' : 'text' }, { text: `Разбор ${view.id} · ${when(view.createdAt)}`, tone: 'dim' }],
    body, items, foot: items.length ? '↑↓ выбрать · Enter открыть · Esc назад' : 'Esc назад' };
}

/** Every factual result remains inspectable, including supported and unknown claims with no problem row. */
function factConversationScreen(entry: AnalysisEntry, dialogueId: string): Screen | undefined {
  const check = entry.analysis.factChecks?.find(check => check.dialogueId === dialogueId);
  if (!check) return undefined;
  const dialogue = entry.batch?.dialogues.find(dialogue => dialogue.id === dialogueId);
  const body: Row[] = [{ text: check.note, tone: 'muted' }];
  if (!check.complete) body.push({ text: 'Проверка не закончена. Предварительные ответы модели не считаются результатом.', tone: 'warning' });
  else check.claims.forEach((claim, index) => {
    const result = claim.result === 'supported' ? 'Подтверждено статьёй' : claim.result === 'contradicted' ? 'Возможное противоречие' : 'Не удалось проверить';
    body.push({ text: '' }, { text: `${index + 1}. ${result}`, bold: true, tone: claim.result === 'supported' ? 'success' : 'warning' },
      { text: `Бот: «${claim.agent.quote}»` });
    if (claim.reference) body.push({ text: `Статья: «${claim.reference.quote}»` },
      { text: entry.analysis.sources.find(source => source.id === claim.reference!.sourceId)?.name ?? claim.reference.sourceId, tone: 'muted' });
    body.push({ text: claim.reason, tone: 'muted' });
  });
  body.push({ text: '' }, { text: 'Исходный разговор:', bold: true, tone: 'accent' },
    ...(dialogue ? conversationLines(dialogue).map((text): Row => ({ text })) : [{ text: 'Исходный разговор не найден в этой папке.', tone: 'warning' } as Row]));
  return { head: [{ text: check.question, bold: true }, { text: `Разговор ${dialogueId}`, tone: 'dim' }], body, items: [], foot: '↑↓ листать · Esc назад' };
}

/** One problem: its size, its rules verbatim, its examples to open. */
function problemScreen(entry: AnalysisEntry, key: string, selected: number): Screen | undefined {
  const index = listed(entry.view).findIndex(problem => problem.key === key);
  const problem = listed(entry.view)[index];
  if (!problem) return undefined;
  const body: Row[] = [{ text: problem.violations ? `В ${problemSize(problem)}.` : `Все нарушения вы оспорили (${problem.disputed}): они не считаются.`, tone: 'muted' },
    ...(problem.knowledgeOnly ? [{ text: entry.view.checking === 'facts'
      ? 'Сравните утверждение бота с цитатой из статьи: относятся ли они к одному факту, продукту и условиям? Перед созданием проверки подтвердите противоречие.'
      : 'Основание — только статьи базы знаний. Подтвердите, обязательны ли эти сведения в ответе и допустима ли передача оператору.', tone: 'warning' as const }] : []),
    ...problem.rules.map((rule): Row => ({ text: `Правило: «${clip(rule.quote, 400)}» — ${rule.source}.` })), { text: '' },
    { text: problem.examples.length ? 'Примеры — откройте, чтобы увидеть разговор целиком и сказать, прав ли судья:' : 'Примеров нет.', tone: 'accent', bold: true }];
  const items: number[] = [];
  problem.examples.forEach((example, at) => {
    items.push(body.length);
    body.push({ text: `${at === selected ? GLYPH.selected : ' '} ${index + 1}.${at + 1} ${exampleLine(example)}`, bold: at === selected });
  });
  if (problem.disputed) body.push({ text: '' }, { text: `Вы оспорили — ${problem.disputed}; они не считаются.`, tone: 'muted' });
  return { head: [{ text: `${index + 1}. ${problemTitle(problem)}`, bold: true, tone: 'warning' }, { text: `Разбор «${entry.view.file}»`, tone: 'dim' }], body, items, foot: '↑↓ выбрать · Enter открыть · Esc назад' };
}

/** One example: the evidence, the judge's reason, the owner's mark, and the logged conversation whole. */
function exampleScreen(entry: AnalysisEntry, key: string, finding: string): Screen | undefined {
  const index = listed(entry.view).findIndex(problem => problem.key === key);
  const problem = listed(entry.view)[index];
  const at = problem?.examples.findIndex(example => example.key === finding) ?? -1;
  const example = problem?.examples[at];
  if (!problem || !example) return undefined;
  const dialogue = entry.batch?.dialogues.find(item => item.id === example.dialogueId);
  const body: Row[] = [
    ...problem.rules.slice(0, 2).map((rule): Row => ({ text: `Правило: «${clip(rule.quote, 400)}» — ${rule.source}.`, tone: 'muted' })),
    { text: 'Доказательства судьи, дословно:', tone: 'accent', bold: true },
    ...example.quotes.map((quote): Row => ({ text: `${quote.seq}. ${quote.role === 'customer' ? 'клиент' : quote.role === 'agent' ? 'агент' : 'в разговоре'}: «${quote.quote}»`, indent: 2 })),
    ...(example.absent ? [{ text: `В полном журнале нет вызова ${example.absent}: действие не выполнено.`, indent: 2 } as Row] : []),
    ...(example.rationale ? [{ text: `Почему, по словам судьи: ${example.rationale}`, tone: 'muted' } as Row] : []),
    { text: example.review ? `Ваша отметка: ${reviewWord(example.review)}.` : 'Вы ещё не отмечали этот пример.', tone: example.review ? 'success' : 'warning' },
    { text: '' }, { text: `Разговор ${example.dialogueId} целиком (→ — что процитировал судья):`, tone: 'accent', bold: true },
    ...(dialogue ? conversationLines(dialogue, example.quotes.map(quote => quote.seq)).map((text): Row => ({ text })) : [{ text: 'Логов этого разбора в папке больше нет: разговор не открыть.', tone: 'warning' } as Row]),
  ];
  return { head: [{ text: `Пример ${index + 1}.${at + 1} · ${problemTitle(problem)}`, bold: true, tone: 'warning' },
    { text: problem.knowledgeOnly ? 'Здесь есть нарушение? 1 да · 2 нет (спросим почему) · 3 не знаю'
      : 'Прав ли судья? 1 — нарушение есть · 2 — не нарушение (спросим почему) · 3 — не знаю', tone: 'text' }],
    body, items: [], foot: '1 нарушение есть · 2 не нарушение · 3 не знаю · ↑↓ листать · Esc назад' };
}

export class AnalysisBoard implements Component {
  private scroll = 0;
  private done = false;
  private loading = false;
  private stale = false;
  private unfollow?: () => void;

  constructor(private view: AnalysisBoardView, private readonly state: AnalysisBoardState, private readonly theme: Pick<Theme, 'fg' | 'bold'>,
    private readonly finish: (action: AnalysisAction) => void, private readonly redraw: () => void, private readonly rows: () => number = () => 32,
    private readonly load?: () => Promise<AnalysisBoardView>, changes?: (changed: () => void) => () => void) {
    // An open object that is gone closes, down to what is still there.
    while (this.state.stack.length && !this.screen(WORKSPACE_WIDTH)) this.state.stack.pop();
    if (load && changes) this.unfollow = changes(() => { void this.refresh(); });
  }

  private async refresh(): Promise<void> {
    if (this.done || !this.load) return;
    if (this.loading) { this.stale = true; return; }
    this.loading = true;
    try {
      const view = await this.load();
      if (this.done) return;
      this.view = view;
      while (this.state.stack.length && !this.screen(WORKSPACE_WIDTH)) this.state.stack.pop();
      this.redraw();
    } catch { /* Keep the readable snapshot; a later checkpoint can refresh it. */ }
    finally { this.loading = false; if (this.stale && !this.done) { this.stale = false; void this.refresh(); } }
  }

  private get top(): AnalysisFrame | undefined { return this.state.stack.at(-1); }
  private entry(id: string): AnalysisEntry | undefined { return this.view.entries.find(item => item.analysis.id === id); }
  private listKey(): string { const top = this.top; return top ? `${top.kind}:${top.id}:${'key' in top ? top.key : ''}` : 'list'; }
  private cursor(count: number): number {
    const stored = this.state.selected[this.listKey()] ?? 0;
    return Math.max(0, Math.min(stored, count - 1));
  }

  /** The screen of what is open; undefined when it is gone. */
  private screen(_width: number, selected?: number): Screen | undefined {
    const top = this.top;
    if (!top) return listScreen(this.view.entries, selected ?? this.cursor(this.view.entries.length));
    const entry = this.entry(top.id);
    if (!entry) return undefined;
    if (top.kind === 'analysis') return analysisScreen(entry, selected ?? this.cursor(this.count()));
    if (top.kind === 'problem') return problemScreen(entry, top.key, selected ?? this.cursor(listed(entry.view).find(problem => problem.key === top.key)?.examples.length ?? 0));
    if (top.kind === 'factConversation') return factConversationScreen(entry, top.dialogueId);
    return exampleScreen(entry, top.key, top.finding);
  }

  /** How many items the open list has. */
  private count(): number {
    const top = this.top;
    if (!top) return this.view.entries.length;
    const entry = this.entry(top.id);
    if (top.kind === 'analysis') return entry ? listed(entry.view).length + (entry.view.checking === 'facts' ? entry.analysis.factChecks?.length ?? 0 : 0) : 0;
    if (top.kind === 'problem') return entry ? listed(entry.view).find(problem => problem.key === top.key)?.examples.length ?? 0 : 0;
    return 0;
  }

  private end(action: AnalysisAction): void { if (this.done) return; this.dispose(); this.finish(action); }
  invalidate(): void {}
  dispose(): void { this.done = true; this.unfollow?.(); this.unfollow = undefined; }

  handleInput(data: string): void {
    if (this.done) return;
    const key = (name: Parameters<typeof matchesKey>[1]) => matchesKey(data, name);
    const top = this.top;
    const count = this.count();
    const cursor = this.cursor(count);
    if (key('ctrl+c')) return this.end({ type: 'close' });
    if (key('escape') || data === 'q' && !top) {
      if (!top) return this.end({ type: 'back' });
      this.state.stack.pop(); this.scroll = 0; this.state.notice = undefined; this.redraw(); return;
    }
    if (key('down') || data === 'j') { if (count) this.state.selected[this.listKey()] = Math.min(count - 1, cursor + 1); else this.scroll++; this.redraw(); return; }
    if (key('up') || data === 'k') { if (count) this.state.selected[this.listKey()] = Math.max(0, cursor - 1); else this.scroll = Math.max(0, this.scroll - 1); this.redraw(); return; }
    if (key('pageDown')) { this.scroll += Math.max(1, this.rows() - 10); this.redraw(); return; }
    if (key('pageUp')) { this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 10)); this.redraw(); return; }
    const digit = ['1', '2', '3'].indexOf(data);
    if (digit >= 0 && top?.kind === 'example') return this.end({ type: 'review', analysisId: top.id, key: top.finding, verdict: VERDICTS[digit]! });
    if (!key('enter') || !count) return;
    this.scroll = 0; this.state.notice = undefined;
    if (!top) { const entry = this.view.entries[cursor]; if (entry) this.state.stack.push({ kind: 'analysis', id: entry.analysis.id }); }
    else if (top.kind === 'analysis') {
      const entry = this.entry(top.id); const problem = entry && listed(entry.view)[cursor];
      if (problem) this.state.stack.push({ kind: 'problem', id: top.id, key: problem.key });
      else if (entry?.view.checking === 'facts') {
        const check = entry.analysis.factChecks?.[cursor - listed(entry.view).length];
        if (check) this.state.stack.push({ kind: 'factConversation', id: top.id, dialogueId: check.dialogueId });
      }
    }
    else if (top.kind === 'problem') {
      const view = this.entry(top.id)?.view;
      const example = view && listed(view).find(problem => problem.key === top.key)?.examples[cursor];
      if (example) this.state.stack.push({ kind: 'example', id: top.id, key: top.key, finding: example.key });
    }
    this.redraw();
  }

  render(width: number): string[] {
    const full = Math.max(20, Math.floor(width));
    const room = Math.min(full, WORKSPACE_WIDTH);
    const margin = ' '.repeat(Math.max(0, Math.floor((full - room) / 2)));
    const screen = this.screen(room) ?? listScreen(this.view.entries, 0);
    const paint = (row: Row): string[] => {
      const indent = ' '.repeat(1 + (row.indent ?? 0));
      const text = safeText(row.text);
      const wrapped = text ? wrapTextWithAnsi(text, Math.max(10, room - indent.length - 1)) : [''];
      return wrapped.map(part => {
        const styled = row.bold ? this.theme.bold(part) : part;
        return `${indent}${row.tone ? this.theme.fg(row.tone, styled) : styled}`;
      });
    };
    const head = [...screen.head.flatMap(paint), ...(this.state.notice ? paint({ text: this.state.notice.text, tone: this.state.notice.tone }) : [])];
    const bodyLines: string[] = [];
    const starts: number[] = [];
    screen.body.forEach((row, index) => { if (screen.items.includes(index)) starts.push(bodyLines.length); bodyLines.push(...paint(row)); });
    const height = Math.max(8, this.rows());
    const window = Math.max(1, height - head.length - 5);
    const selected = starts[this.cursor(this.count())];
    // A list keeps its selected item in view; a page with no list scrolls on ↑↓.
    if (selected !== undefined) {
      if (selected < this.scroll) this.scroll = selected;
      if (selected >= this.scroll + window) this.scroll = selected - window + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, bodyLines.length - window)));
    const shown = bodyLines.slice(this.scroll, this.scroll + window);
    const more = bodyLines.length - this.scroll - shown.length;
    const border = this.theme.fg('borderMuted', '─'.repeat(room));
    const foot = ` ${this.theme.fg('muted', safeLine(screen.foot))}`;
    const lines = [border, ...head, '', ...shown, ...(more > 0 ? [this.theme.fg('muted', ` ${GLYPH.more} ниже ещё ${more}`)] : []), '', foot, border];
    return lines.map(line => margin + (visibleWidth(line) > room ? truncateToWidth(line, room, '…') : line));
  }
}

/** Shows the folder's analyses until the owner acts: back to the workspace, closes, or gives their word on an example. */
export function showAnalyses(ctx: ExtensionContext, view: AnalysisBoardView, state: AnalysisBoardState,
  load?: () => Promise<AnalysisBoardView>, changes?: (changed: () => void) => () => void): Promise<AnalysisAction> {
  return ctx.ui.custom<AnalysisAction>((tui, theme, _keys, done) => new AnalysisBoard(view, state, theme, done, () => tui.requestRender(), () => tui.terminal.rows, load, changes),
    { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
