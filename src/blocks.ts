import { stripVTControlCharacters } from 'node:util';
import type { Brief } from './card/view.js';
import { FONT_STYLESHEET, REPORT_CSS, REPORT_SCRIPT, REPORT_SCRIPT_HASH } from './report-style.js';
import type { Level } from './result-text.js';

/*
 * The customer report as a small tree of blocks, and its two renderings: `toHtml` (the styled,
 * self-contained file) and `toMarkdown` (its plain twin). The report builder decides what is said
 * and in which order; nothing here adds a word of content. Every string from a record is escaped
 * here and only here, at the boundary of each format.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'accent';
export interface Turn { who: 'Клиент' | 'Агент'; text: string }
export interface Example { situation: string; expected: string; said: string | null; rule: string | null }
export interface CardItem { number: number; brief: Brief; chip: { text: string; tone: Tone }; dialogue: Turn[] }
export interface FailureItem { number: number; title: string; expected: string; said: string | null; rule: { quote: string; source: string } | null; dialogue: Turn[];
  /** What the customer's side may have done to the verdict («ответ клиента «не знаю» мог помешать»); absent when nothing. */
  customer?: string }
/** A situation where the synthetic customer and the logged one led to different verdicts; the logged conversation is named, never quoted. */
export interface DisagreementItem { number: number; title: string; expectations: string[]; hint: string; conversations: string; dialogue: Turn[] }

export type Block =
  | { kind: 'alarm'; text: string }
  | { kind: 'accuracy'; lead: string; value: string | null; tail: string; level: Level;
      /** The 95% interval under the number; `point` and `weighted` are shares 0..1. */
      band: { point: number; range: [number, number]; weighted: number | null } | null }
  | { kind: 'trust'; parts: { text: string; warn: boolean }[] }
  | { kind: 'section'; title: string; blocks: Block[] }
  | { kind: 'table'; head: string[]; rows: { cells: string[]; muted: boolean }[] }
  | { kind: 'causes'; items: { title: string; count: string; examples: Example[] }[] }
  | { kind: 'cards'; items: CardItem[] }
  | { kind: 'failures'; items: FailureItem[] }
  | { kind: 'disagreements'; items: DisagreementItem[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string; muted: boolean };

/** `head` is the result block at the top (alarm, number, trust, reality); `blocks` are the sections under it. */
export interface Report { title: string; meta: string[]; head: Block[]; blocks: Block[]; footer: string[] }

const plain = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
export const escapeHtml = (value: unknown) => plain(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const escapeMarkdown = (value: unknown) => plain(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/[\\`*_{}\[\]()#|]/g, '\\$&');
const e = escapeHtml;
const md = escapeMarkdown;
const pct = (share: number) => Math.round(share * 100);

function bandHtml(band: NonNullable<Extract<Block, { kind: 'accuracy' }>['band']>): string {
  const [lo, hi] = band.range.map(pct) as [number, number];
  const labels = [`<span class="lb l0">0%</span>`, `<span class="lb l100">100%</span>`];
  const shown = [0, 100];
  // Labels near the edges or one another overlap on a narrow report. The ticks and range remain visible.
  const add = (at: number, label: string, className = '', gap = 12) => {
    if (shown.some(position => Math.abs(position - at) < gap)) return;
    labels.push(`<span class="lb${className}" style="left:${at}%">${label}</span>`);
    shown.push(at);
  };
  add(lo, `${lo}%`);
  add(hi, `${hi}%`);
  if (band.weighted !== null) add(pct(band.weighted), `≈${pct(band.weighted)}%`, ' fr', 16);
  return `<div class="band" aria-hidden="true"><span class="track"></span><span class="range" style="left:${lo}%;width:${Math.max(hi - lo, 1)}%"></span>`
    + (band.weighted === null ? '' : `<span class="tick" style="left:${pct(band.weighted)}%"></span>`)
    + `<span class="dot" style="left:${pct(band.point)}%"></span>${labels.join('')}</div>`;
}

const dl = (rows: [string, string, string?][]) => `<dl>${rows.map(([term, value, cls]) => `<div><dt>${e(term)}</dt><dd${cls ? ` class="${cls}"` : ''}>${e(value)}</dd></div>`).join('')}</dl>`;
const turnsHtml = (turns: Turn[]) => `<div class="turns">${turns.map(turn => `<div class="turn${turn.who === 'Клиент' ? ' client' : ''}"><span class="who">${e(turn.who)}</span><span>${e(turn.text)}</span></div>`).join('')}</div>`;

function cardHtml(item: CardItem): string {
  const { brief } = item;
  const client: [string, string, string?][] = [['Хочет', brief.wants], ['Пишет', `«${brief.writes}»`],
    ...brief.knows.map(fact => ['Знает', `${fact.what} — ${fact.when}`] as [string, string]), ...(brief.leaves ? [['Уходит', brief.leaves] as [string, string]] : []),
    ...(brief.turn ? [['Поворот', brief.turn] as [string, string]] : [])];
  return `<details class="card"><summary><div class="l1"><span class="ttl"><span class="num">${item.number}</span>${e(brief.title)}</span><span class="chip ${item.chip.tone}">${e(item.chip.text)}</span></div>`
    + `<span class="srcline">${e(brief.source)}</span><span class="peek">Клиент: «${e(brief.writes)}»</span></summary>`
    + `<div class="body"><div class="sec"><h3>КЛИЕНТ</h3><div class="kv">${dl(client)}</div></div>`
    + `<div class="sec"><h3>АГЕНТ ДОЛЖЕН</h3><ol class="must">${brief.must.map((must, i) => `<li><span class="i">${i + 1}.</span><div><div>${e(must.text)}</div>${must.rule ? `<div class="rule">правило: «${e(must.rule)}»</div>` : ''}</div></li>`).join('')}</ol></div>`
    + (item.dialogue.length ? `<details class="fold"><summary>Разговор в прогоне</summary>${turnsHtml(item.dialogue)}</details>` : '') + `</div></details>`;
}

function failureHtml(item: FailureItem): string {
  return `<article class="failure"><div class="ttl"><span class="mark">✗ ${item.number}</span>${e(item.title)}</div>`
    + dl([['Ожидалось', item.expected], ['Агент ответил', item.said === null ? 'ответ не подтверждён цитатой' : `«${item.said}»`, item.said === null ? undefined : 'bad-quote'],
      ['Правило', item.rule ? `«${item.rule.quote}» — ${item.rule.source}` : 'у ситуации нет правила из ваших материалов'],
      ...(item.customer ? [['Клиент', item.customer] as [string, string]] : [])])
    + (item.dialogue.length ? `<details class="fold"><summary>Разговор</summary>${turnsHtml(item.dialogue)}</details>` : '') + `</article>`;
}

function disagreementHtml(item: DisagreementItem): string {
  return `<article class="failure"><div class="ttl"><span class="mark">≠ ${item.number}</span>${e(item.title)}</div>`
    + dl([...item.expectations.map(text => ['Ожидание', text] as [string, string]), ['Подсказка', item.hint], ['Где смотреть', item.conversations]])
    + (item.dialogue.length ? `<details class="fold"><summary>Разговор в прогоне</summary>${turnsHtml(item.dialogue)}</details>` : '') + `</article>`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'alarm': return `<p class="alarm">${e(block.text)}</p>`;
    case 'accuracy': return `<div class="acc ${block.level}"><span>${e(block.lead)}</span>${block.value ? `<span class="pct">${e(block.value)}</span>` : ''}<span>${e(block.tail)}</span></div>`
      + (block.band ? `<div class="${block.level}">${bandHtml(block.band)}</div>` : '');
    case 'trust': return `<div class="trust">${block.parts.map(part => `<span${part.warn ? ' class="warn"' : ''}>${e(part.text)}</span>`).join('')}</div>`;
    case 'section': return `<section><h2>${e(block.title)}</h2>${block.blocks.map(blockHtml).join('')}</section>`;
    case 'table': return `<table><thead><tr>${block.head.map(cell => `<th>${e(cell)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr${row.muted ? ' class="muted"' : ''}>${row.cells.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'causes': return `<div class="why">${block.items.map((cause, i) => `<details class="cause"${i ? '' : ' open'}><summary><span class="i">${i + 1}.</span><span class="t">${e(cause.title)}</span><span class="n">${e(cause.count)}</span><span class="chev">›</span></summary>`
      + `<div class="exs">${cause.examples.map(example => `<div class="ex"><span class="st">${e(example.situation)}</span>${dl([['Ожидалось', example.expected],
        ['Агент ответил', example.said === null ? 'ответ не подтверждён цитатой' : `«${example.said}»`, example.said === null ? undefined : 'bad-quote'], ...(example.rule ? [['Правило', `«${example.rule}»`] as [string, string]] : [])])}</div>`).join('')}</div></details>`).join('')}</div>`;
    case 'cards': return `<div class="cards">${block.items.map(cardHtml).join('')}</div>`;
    case 'failures': return `<div class="cards">${block.items.map(failureHtml).join('')}</div>`;
    case 'disagreements': return `<div class="cards">${block.items.map(disagreementHtml).join('')}</div>`;
    case 'list': return `<ul class="plain">${block.items.map(item => `<li>${e(item)}</li>`).join('')}</ul>`;
    case 'paragraph': return `<p${block.muted ? ' class="muted"' : ''}>${e(block.text)}</p>`;
  }
}

/** The report as one self-contained HTML file: inline style and one hashed script; fonts are optional. */
export function toHtml(report: Report): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${REPORT_SCRIPT_HASH}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'">
<title>${e(report.title)}</title>
<link rel="stylesheet" href="${FONT_STYLESHEET}">
<style>${REPORT_CSS}</style></head><body><main class="stage">
<header class="top"><span><b>Agent Lab</b> · отчёт о проверке агента</span><span>${report.meta.map(e).join(' · ')}</span></header>
<section class="win" aria-label="${e(report.title)}"><div class="wbar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="wtitle">${e(report.title)}</span><span class="wsp" aria-hidden="true"></span></div>
<div class="screen"><div class="result">${report.head.map(blockHtml).join('')}</div>${report.blocks.map(blockHtml).join('\n')}
<footer class="foot">${report.footer.map(line => `<span>${e(line)}</span>`).join('')}</footer></div></section>
</main><script>${REPORT_SCRIPT}</script></body></html>`;
}

const mdDl = (rows: [string, string][]) => rows.map(([term, value]) => `- ${md(term)}: ${md(value)}`);
const mdTurns = (turns: Turn[]) => turns.map(turn => `> **${md(turn.who)}:** ${md(turn.text)}`);

function blockMarkdown(block: Block): string[] {
  switch (block.kind) {
    case 'alarm': return [`> **${md(block.text)}**`, ''];
    case 'accuracy': return [`**${md([block.lead, block.value].filter(Boolean).join(' '))}** ${md(block.tail)}`, ''];
    case 'trust': return [block.parts.map(part => md(part.text)).join(' · '), ''];
    case 'section': return [`## ${md(block.title)}`, '', ...block.blocks.flatMap(blockMarkdown)];
    case 'table': return [`| ${block.head.map(md).join(' | ')} |`, `| ${block.head.map((_, i) => i ? '---:' : '---').join(' | ')} |`,
      ...block.rows.map(row => `| ${row.cells.map(md).join(' | ')} |`), ''];
    case 'causes': return block.items.flatMap((cause, i) => [`${i + 1}. **${md(cause.title)}** — ${md(cause.count)}`,
      ...cause.examples.flatMap(example => [`   - ${md(example.situation)}`, `     - Ожидалось: ${md(example.expected)}`,
        `     - Агент ответил: ${example.said === null ? 'ответ не подтверждён цитатой' : `«${md(example.said)}»`}`, ...(example.rule ? [`     - Правило: «${md(example.rule)}»`] : [])])]).concat('');
    case 'cards': return block.items.flatMap(item => [`### ${item.number}. ${md(item.brief.title)} — ${md(item.chip.text)}`, '', md(item.brief.source), '', '**Клиент**', '',
      ...mdDl([['Хочет', item.brief.wants], ['Пишет', `«${item.brief.writes}»`], ...item.brief.knows.map(fact => ['Знает', `${fact.what} — ${fact.when}`] as [string, string]),
        ...(item.brief.leaves ? [['Уходит', item.brief.leaves] as [string, string]] : []),
        ...(item.brief.turn ? [['Поворот', item.brief.turn] as [string, string]] : [])]), '', '**Агент должен**', '',
      ...item.brief.must.map((must, i) => `${i + 1}. ${md(must.text)}${must.rule ? ` — правило: «${md(must.rule)}»` : ''}`), '',
      ...(item.dialogue.length ? ['**Разговор в прогоне**', '', ...mdTurns(item.dialogue), ''] : [])]);
    case 'failures': return block.items.flatMap(item => [`### ✗ ${item.number}. ${md(item.title)}`, '',
      ...mdDl([['Ожидалось', item.expected], ['Агент ответил', item.said === null ? 'ответ не подтверждён цитатой' : `«${item.said}»`],
        ['Правило', item.rule ? `«${item.rule.quote}» — ${item.rule.source}` : 'у ситуации нет правила из ваших материалов'],
        ...(item.customer ? [['Клиент', item.customer] as [string, string]] : [])]), '',
      ...(item.dialogue.length ? [...mdTurns(item.dialogue), ''] : [])]);
    case 'disagreements': return block.items.flatMap(item => [`### ≠ ${item.number}. ${md(item.title)}`, '',
      ...mdDl([...item.expectations.map(text => ['Ожидание', text] as [string, string]), ['Подсказка', item.hint], ['Где смотреть', item.conversations]]), '',
      ...(item.dialogue.length ? ['**Разговор в прогоне**', '', ...mdTurns(item.dialogue), ''] : [])]);
    case 'list': return [...block.items.map(item => `- ${md(item)}`), ''];
    case 'paragraph': return [md(block.text), ''];
  }
}

/** The plain twin of the HTML report: the same blocks, in the same order, as Markdown. */
export function toMarkdown(report: Report): string {
  return [`# ${md(report.title)}`, '', report.meta.map(md).join(' · '), '', ...[...report.head, ...report.blocks].flatMap(blockMarkdown), '---', '', ...report.footer.map(md)].join('\n');
}
