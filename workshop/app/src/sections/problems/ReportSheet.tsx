import { useState } from "react";
import { Copy, FileDown } from "lucide-react";
import type { Criterion } from "../../lab/criteria";
import { day, plural } from "../../lab/format";
import { download, problemsReport, reliabilityWord, summarySentence } from "../../lab/problemReport";
import type { Problems } from "../../lab/problems";
import { secondOf } from "../../lab/problemStats";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { checked, queueOf, violationsOf, type SideKey } from "./model";

const Cap = ({ children }: { children: string }) => <span className="font-mono text-label uppercase tracking-caps text-ink-3">{children}</span>;

/** One violation of the protocol: what, how often, and the two quotes side by side, the code's and the agent's. */
function Section({ c, i, side }: { c: Criterion; i: number; side: SideKey }) {
  const s = c.r[side];
  const e = violationsOf(c, side)[0];
  const second = secondOf(s.examples);
  return (
    <section className="mt-10 break-inside-avoid">
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-baseline">
        <span className="font-mono text-lead text-ink-3">{i}</span>
        <h3 className="text-balance text-lead font-semibold text-ink">{c.r.title}</h3>
        <p className="col-start-2 mt-1 text-small text-ink-2">
          Ошибка в <b className="font-semibold text-ink-bad">{s.failed} из {checked(s)}</b> {plural(checked(s), "разговора", "разговоров", "разговоров")}, где критерий удалось проверить.
          {second.checked > 0 && ` Две проверки совпали в ${second.agree} из ${second.checked}.`}
          {c.r.topics.length > 0 && ` Темы: ${c.r.topics.join(", ").toLowerCase()}.`}
        </p>
      </div>
      <div className="mt-4 grid overflow-hidden rounded-block border border-ink-line sm:ml-7 sm:grid-cols-2">
        <div className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Cap>Код агента требует</Cap><span className="font-mono text-meta text-ink-3">{shortOrigin(c.r.rule.origin)}</span></div>
          <p className="mt-2.5 text-read text-ink">«{c.r.rule.quote}»</p>
        </div>
        <div className="border-t border-ink-line p-4 sm:border-l sm:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><Cap>Агент ответил</Cap>{e && <span className="text-small text-ink-3">{reliabilityWord(e)}</span>}</div>
          {e ? (
            <>
              <p className="mt-2.5 inline-block rounded-xl rounded-br-sm bg-paper-well px-3 py-1.5 text-small text-ink-2">{e.opening}</p>
              <p className="mt-2 text-read text-ink"><mark className="rounded-sm bg-warn/40 px-0.5 text-ink">{e.agentQuote}</mark></p>
              <p className="mt-2 text-small text-ink-2">Почему это ошибка: {e.reason}</p>
            </>
          ) : <p className="mt-2.5 text-small text-ink-3">Примера нет.</p>}
        </div>
      </div>
    </section>
  );
}

/**
 * «Отчёт»: the assessment as a protocol to send, a white sheet inside the product. Logs and simulation are never in one
 * report. «Скопировать для письма» puts the same in Markdown, each violation with its link.
 */
export function ReportSheet({ open, onClose, data, list }: { open: boolean; onClose: () => void; data: Problems; list: Criterion[] }) {
  const toast = useToast();
  const sides = ([["log", "Логи"], ["sim", "Симуляция"]] as const).filter(([k]) => (k === "log" ? !!data.log : !!data.sim));
  const [side, setSide] = useState<SideKey>(data.log ? "log" : "sim");
  const items = queueOf(list, side);
  const markdown = () => problemsReport(data, window.location.origin, side);
  const copy = () => navigator.clipboard.writeText(markdown()).then(() => toast.notify("Отчёт скопирован: вставьте в письмо или тикет"), toast.error);
  const log = data.log;
  const sim = data.sim;
  const figures = side === "log" && log
    ? [[`${log.assessed}`, `из ${log.sampled}`, "разговоров проверено"], [`${log.withViolations}`, "", "с ошибкой агента"], [`${log.assessed - log.withViolations}`, "", "без найденных ошибок"], [`${log.unassessed}`, "", "не удалось проверить"]]
    : sim ? [[`${sim.dialogs}`, "", "разговоров сыграно"], [`${sim.withViolations}`, "", "с ошибкой агента"], [`${sim.dialogs - sim.withViolations}`, "", "без найденных ошибок"]] : [];
  return (
    <Sheet open={open} onClose={onClose} width="lg" title="Отчёт" sub="Протокол текущей оценки: так он уйдёт в письмо или тикет"
      actions={<>
        {sides.length > 1 && <Segmented<SideKey> size="sm" label="Чей протокол" value={side} onChange={setSide} options={sides.map(([k, l]) => ({ value: k, label: l }))} />}
        <Button variant="ghost" icon={FileDown} aria-label="Скачать Markdown" onClick={() => download(`otchet-${side === "log" ? "logi" : "simulyaciya"}.md`, markdown())} />
        <Button variant="primary" icon={Copy} onClick={copy}>Скопировать для письма</Button>
      </>}>
      <div className="bg-canvas px-3 py-6 sm:px-8">
        <article className="mx-auto max-w-3xl rounded-block bg-paper px-6 pb-12 pt-9 text-ink shadow-pop sm:px-12">
          <Cap>{side === "log" ? `Протокол проверки · логи · ${day(log?.finishedAt)}` : `Протокол проверки · симуляция · ${day(sim?.finishedAt)}`}</Cap>
          <h2 className="mt-3 text-balance text-title font-semibold text-ink">{summarySentence(data, side)}</h2>
          {side === "log" && log && <p className="mt-3 text-read text-ink-2">Проверено {log.assessed} из {log.sampled} разговоров логов. В {log.withViolations} агент ошибся хотя бы раз, {log.unassessed} проверить не удалось.</p>}
          {side === "sim" && sim && <p className="mt-3 text-read text-ink-2">Прогон {sim.target} · {sim.version}: {sim.dialogs} разговоров, ошибка в {sim.withViolations}.</p>}
          <dl className="mt-6 grid grid-cols-2 border-t border-ink sm:grid-cols-4">
            {figures.map(([v, of, l], i) => (
              <div key={l} className={i > 0 ? "border-ink-line pt-3 sm:border-l sm:pl-4" : "pt-3"}>
                <dd className={i === 1 ? "font-mono text-count font-medium text-ink-bad" : "font-mono text-count font-medium text-ink"}>{v}{of && <span className="ml-1 text-small font-normal text-ink-3">{of}</span>}</dd>
                <dt className="mt-0.5 text-small text-ink-3">{l}</dt>
              </div>
            ))}
          </dl>
          {items.map((c, i) => <Section key={c.r.id} c={c} i={i + 1} side={side} />)}
          {!items.length && <p className="mt-10 text-read text-ink-2">Ошибок не найдено.</p>}
          <p className="mt-12 border-t border-ink-line pt-4 text-small text-ink-3">Счёт «N из M»: M — разговоры, где критерий удалось проверить. Логи и симуляция считаются отдельно и не складываются. «Без найденных ошибок» не означает, что агент исправен.</p>
        </article>
      </div>
    </Sheet>
  );
}
