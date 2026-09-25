import { createHash } from 'node:crypto';

/*
 * The look of the customer report: the palette, type and anatomy of the approved card prototype
 * (dark window, a sans face with a mono accent, status chips, the large accuracy figure, the client /
 * agent brief). It is one offline file that fetches nothing: the type is the reader's own system faces,
 * so opening it reaches no server; print gets a light page.
 */

/** Opens every folded section before printing, so paper carries the whole report. The only script the CSP allows. */
export const REPORT_SCRIPT = `addEventListener('beforeprint',()=>{for(const d of document.querySelectorAll('details'))d.open=true});`;
export const REPORT_SCRIPT_HASH = createHash('sha256').update(REPORT_SCRIPT).digest('base64');

export const REPORT_CSS = `
:root{color-scheme:dark;
--page:#0a0c0f;--glow:#132031;--win:#0f1216;--bar:#14181d;--edge:#252b33;--line:#1d232a;--hover:#171c22;--well:#0c0f13;
--text:#d5dae0;--bright:#f1f4f7;--muted:#8b949e;--dim:#5b646e;
--accent:#86b1d6;--accent-bg:rgba(134,177,214,.1);--accent-line:rgba(134,177,214,.36);
--ok:#8dc39c;--ok-bg:rgba(141,195,156,.1);--ok-line:rgba(141,195,156,.34);
--warn:#d7b16b;--warn-bg:rgba(215,177,107,.09);--warn-line:rgba(215,177,107,.36);
--err:#df837a;--err-bg:rgba(223,131,122,.1);--err-line:rgba(223,131,122,.36);
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;background:var(--page)}
body{margin:0;background:var(--page) radial-gradient(1000px 480px at 50% -140px,var(--glow),transparent 72%) no-repeat;color:var(--text);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
.stage{max-width:1040px;margin:0 auto;padding:clamp(18px,3.4vw,40px) clamp(16px,4vw,40px) 32px;display:grid;gap:16px;min-width:0}
.top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 20px;font:13.5px/1.4 var(--mono);color:var(--muted)}
.top b{font-size:15px;color:var(--bright);letter-spacing:-.01em}
.top .meta{display:flex;flex-wrap:wrap;column-gap:1ch}
.top .meta span:not(:last-child)::after,.trust span:not(:last-child)::after{content:"\\00a0·";color:var(--dim)}
.win{min-width:0;background:var(--win);border:1px solid var(--edge);border-radius:14px;overflow:hidden;box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 40px 90px -36px rgba(0,0,0,.85),0 12px 30px -18px rgba(0,0,0,.6)}
.wbar{display:flex;align-items:center;gap:12px;height:38px;padding-inline:14px;background:var(--bar);border-bottom:1px solid var(--line)}
.dots,.wsp{display:flex;gap:8px;width:52px;flex:none}
.dots i{width:12px;height:12px;border-radius:50%;background:#e8695d}.dots i:nth-child(2){background:#dfb24e}.dots i:nth-child(3){background:#5fbf55}
.wtitle{flex:1;min-width:0;text-align:center;font:500 12px/1 var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.screen{display:grid;gap:30px;padding:26px clamp(16px,3vw,34px) 28px;overflow-wrap:break-word}
h2{margin:0 0 10px;font:700 12px/1.5 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
p{margin:0}
.muted{color:var(--muted)}.dim{color:var(--dim)}
.alarm{padding:10px 14px;border:1px solid var(--err-line);border-radius:10px;background:var(--err-bg);color:var(--err);font-weight:600}
.result{display:grid;gap:14px}
.acc{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .8ch;color:var(--bright);font-size:clamp(17px,2.1vw,22px);line-height:1.35}
.pct{display:inline-block;font-weight:700;font-size:1.8em;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.good .pct{color:var(--ok)}.warn .pct{color:var(--warn)}.bad .pct{color:var(--err)}.none{color:var(--muted)}
.trust{display:flex;flex-wrap:wrap;column-gap:1ch;color:var(--muted)}.trust .warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;max-width:720px;font-variant-numeric:tabular-nums}
th{font:500 12px/1.5 var(--mono);color:var(--dim);text-align:right;padding:0 0 6px 18px}
th:first-child,td:first-child{text-align:left;padding-left:0}
td{padding:6px 0 6px 18px;border-top:1px solid var(--line);text-align:right;white-space:nowrap}
td:first-child{white-space:normal;color:var(--bright)}
tr.muted td,tr.muted td:first-child{color:var(--muted)}
.why{display:grid;gap:4px}
details>summary{list-style:none;cursor:pointer}details>summary::-webkit-details-marker{display:none}
.cause summary{display:grid;grid-template-columns:3ch minmax(0,1fr) auto 1.5ch;column-gap:1ch;align-items:baseline;padding:8px 10px;border:1px solid transparent;border-radius:9px}
.cause summary:hover{background:var(--hover);border-color:var(--line)}
.cause .i{color:var(--accent);font-family:var(--mono)}.cause .t{color:var(--bright)}.cause .n{color:var(--muted);white-space:nowrap}
.chev{display:inline-block;text-align:center;color:var(--dim);transition:transform .25s ease}
details[open]>summary .chev{transform:rotate(90deg)}
.exs{display:grid;gap:12px;margin:4px 0 8px calc(10px + 4ch);padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--well)}
.ex{display:grid;gap:2px}.ex .st{color:var(--bright)}
dl{margin:0;display:grid;gap:3px}
dl>div{display:grid;grid-template-columns:14ch minmax(0,1fr);column-gap:1ch}
dt{color:var(--muted)}dd{margin:0}
.bad-quote{color:var(--err)}
.chip{flex:0 1 auto;min-width:0;max-width:100%;display:inline-block;padding:0 9px;border-radius:12px;border:1px solid;font-size:.86em;line-height:1.75;overflow-wrap:anywhere}
.chip.ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}
.chip.warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}
.chip.err{color:var(--err);background:var(--err-bg);border-color:var(--err-line)}
.chip.accent{color:var(--accent);background:var(--accent-bg);border-color:var(--accent-line)}
.cards{display:grid;gap:10px}
.card{border:1px solid var(--line);border-radius:12px;background:var(--well)}
.card>summary{display:grid;gap:2px;padding:12px 16px}
.card .l1{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:4px 14px}
.card .ttl{color:var(--bright);font-weight:600}
.card .num{color:var(--dim);font-family:var(--mono);margin-right:1ch}
.card .srcline,.card .peek{color:var(--muted);font-size:.93em}
.card[open] .peek{display:none}
.card .body{display:grid;gap:18px;padding:4px 16px 16px;border-top:1px solid var(--line);padding-top:14px}
.sec{display:grid;gap:6px}
.sec h3{margin:0;font:700 12px/1.5 var(--mono);letter-spacing:.14em;color:var(--accent)}
.kv{padding-left:2ch}.kv>div{grid-template-columns:8ch minmax(0,1fr)}
.when{color:var(--accent)}
.must{list-style:none;margin:0;padding-left:2ch;display:grid;gap:10px}
.must li{display:grid;grid-template-columns:3ch minmax(0,1fr)}
.must .i{color:var(--accent);font-family:var(--mono)}
.rule{color:var(--muted);font-size:.93em}
.failure{display:grid;gap:10px;padding:14px 16px;border:1px solid var(--err-line);border-radius:12px;background:var(--well)}
.failure .ttl{color:var(--bright);font-weight:600}.failure .mark{color:var(--err);margin-right:1ch}
.turns{display:grid;gap:6px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--win);font-size:.93em}
.turn{display:grid;grid-template-columns:7ch minmax(0,1fr);column-gap:1ch}
.turn .who{color:var(--muted)}.turn.client .who{color:var(--accent)}
.fold>summary{color:var(--muted);border-bottom:1px dashed var(--dim);display:inline-block}
.fold[open]>summary{margin-bottom:8px}
ul.plain,ol.plain{margin:0;padding-left:2.4ch;display:grid;gap:4px}
.foot{color:var(--dim);font-size:12.5px;display:grid;gap:4px}
@media (max-width:640px){.exs{margin-left:0}dl>div{grid-template-columns:minmax(0,1fr)}.cause summary{grid-template-columns:3ch minmax(0,1fr) 1.5ch}.cause .n{grid-column:2}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{
:root{color-scheme:light;--page:#fff;--glow:#fff;--win:#fff;--bar:#f4f5f7;--edge:#d4d8de;--line:#e3e6ea;--hover:#f4f5f7;--well:#fafbfc;
--text:#1b1f24;--bright:#000;--muted:#4d5661;--dim:#6b7580;--accent:#1f5f8f;--accent-bg:#eef4f9;--accent-line:#a9c4db;
--ok:#1f7a3a;--ok-bg:#edf7f0;--ok-line:#a8d3b4;--warn:#8a5a00;--warn-bg:#fdf6e7;--warn-line:#e4c98d;--err:#b0322a;--err-bg:#fcefee;--err-line:#e7aba6}
body{background:#fff;font-size:12.5px}.stage{max-width:none;padding:0}.win{box-shadow:none;border-radius:8px}
.card,.failure,.cause{break-inside:avoid}.chev{display:none}}
`;
