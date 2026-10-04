import { useState, type ReactNode } from "react";
import { Copy, FileDown } from "lucide-react";
import { CHECK_NAME } from "../../lab/checks";
import type { Criterion } from "../../lab/criteria";
import { count, day, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import {
  copyReport,
  download,
  problemsReport,
  reliabilityWord,
  sourceLabel,
  summarySentence,
} from "../../lab/problemReport";
import type { Problems } from "../../lab/problems";
import { secondOf } from "../../lab/problemStats";
import { seriousOf, seriousSentence } from "../../lab/severity";
import { SeriousTag } from "../../product/Severity";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { checked, queueOf, violationsOf, type SideKey } from "./model";
import { shareBase } from "../../app/agent";

const Cap = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-label uppercase tracking-caps text-ink-3">{children}</span>
);

/** One violation of the protocol: what, how often, and the two quotes side by side, the code's and the agent's. */
function Section({ c, i, side }: { c: Criterion; i: number; side: SideKey }) {
  const s = c.r[side];
  const e = violationsOf(c, side)[0];
  const second = secondOf(s.examples);
  return (
    <section className="mt-10 break-inside-avoid">
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-baseline">
        <span className="font-mono text-lead text-ink-3">{i}</span>
        <h3 className="text-balance text-lead font-semibold text-ink">
          {c.r.title}
          {c.r.serious && <SeriousTag paper className="relative -top-px ml-2 align-middle font-normal" />}
        </h3>
        <p className="col-start-2 mt-1 text-small text-ink-2">
          Ошибка в{" "}
          <b className="font-semibold text-ink-bad">
            {s.failed} из {checked(s)}
          </b>{" "}
          {plural(checked(s), "разговора", "разговоров", "разговоров")}, где критерий удалось проверить.
          {second.checked > 0 && ` Две проверки совпали в ${second.agree} из ${second.checked}.`}
          {c.r.topics.length > 0 && ` Темы: ${c.r.topics.join(", ").toLowerCase()}.`}
        </p>
      </div>
      <div className="mt-4 grid overflow-hidden rounded-block border border-ink-line sm:ml-7 sm:grid-cols-2">
        <div className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Cap>{sourceLabel(c.r.rule.kind)}</Cap>
            <span className="font-mono text-meta text-ink-3">{shortOrigin(c.r.rule.origin)}</span>
          </div>
          <p className="mt-2.5 text-read text-ink">
            {c.r.rule.quote
              ? `«${c.r.rule.quote}»`
              : c.r.rule.kind === "tone-of-voice"
                ? "Цитата из правил не сохранена."
                : "Цитата из кода не сохранена в этом прогоне."}
          </p>
        </div>
        <div className="border-t border-ink-line p-4 sm:border-l sm:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Cap>Агент ответил</Cap>
            {e && <span className="text-small text-ink-3">{reliabilityWord(e)}</span>}
          </div>
          {e ? (
            <>
              <p className="mt-2.5 inline-block rounded-xl rounded-br-sm bg-paper-well px-3 py-1.5 text-small text-ink-2">
                {e.opening}
              </p>
              <p className="mt-2 text-read text-ink">
                <mark className="rounded-sm bg-warn/40 px-0.5 text-ink">{e.agentQuote}</mark>
              </p>
              <p className="mt-2 text-small text-ink-2">Почему это ошибка: {e.reason}</p>
            </>
          ) : (
            <p className="mt-2.5 text-small text-ink-3">Примера нет.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * «Отчёт»: a check's assessment as a protocol to send, a white sheet inside the product. Its conversations and its
 * simulation are never in one report. The problems a person marked serious come first, marked «серьёзная», and the
 * conversations with a serious error stand under the numbers of the conversations. «Скопировать для письма» puts the
 * same on the clipboard formatted and as plain text without Markdown marks, each problem with its link; the downloaded
 * file is Markdown.
 */
export function ReportSheet({
  open,
  onClose,
  data,
  list,
}: {
  open: boolean;
  onClose: () => void;
  data: Problems;
  list: Criterion[];
}) {
  const toast = useToast();
  // The export the conversations come from: named as the tone-of-voice report names it.
  const file = useLabState().state?.logs.file ?? undefined;
  const sides = (
    [
      ["log", "Диалоги"],
      ["sim", "Симуляция"],
    ] as const
  ).filter(([k]) => (k === "log" ? !!data.log : !!data.sim));
  const [side, setSide] = useState<SideKey>(data.log ? "log" : "sim");
  const items = queueOf(list, side);
  const markdown = () => problemsReport(data, shareBase(), side, { filename: file });
  const copy = () =>
    copyReport(markdown()).then(() => toast.notify("Отчёт скопирован: вставьте в письмо или тикет"), toast.error);
  const log = data.log;
  const sim = data.sim;
  const serious = side === "log" ? seriousOf(data) : null;
  const grave = serious && seriousSentence(serious, "people");
  const figures =
    side === "log" && log
      ? [
          [`${log.assessed}`, `из ${log.sampled}`, "разговоров проверено"],
          [`${log.withViolations}`, "", "с ошибкой агента"],
          [`${log.assessed - log.withViolations}`, "", "без найденных ошибок"],
          [`${log.unassessed}`, "", "не удалось проверить"],
        ]
      : sim
        ? [
            [`${sim.assessed}`, `из ${sim.dialogs}`, "разговоров проверено"],
            [`${sim.withViolations}`, "", "с ошибкой агента"],
            [`${sim.assessed - sim.withViolations}`, "", "без найденных ошибок"],
            [`${sim.unassessed}`, "", "не удалось проверить"],
          ]
        : [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      title="Отчёт"
      sub="Протокол текущей оценки: так он уйдёт в письмо или тикет"
      actions={
        <>
          {sides.length > 1 && (
            <Segmented<SideKey>
              size="sm"
              label="Чей протокол"
              value={side}
              onChange={setSide}
              options={sides.map(([k, l]) => ({ value: k, label: l }))}
            />
          )}
          <Button
            variant="ghost"
            icon={FileDown}
            aria-label="Скачать Markdown"
            onClick={() => download(`otchet-${side === "log" ? "dialogi" : "simulyaciya"}.md`, markdown())}
          />
          <Button variant="primary" icon={Copy} onClick={copy}>
            Скопировать для письма
          </Button>
        </>
      }
    >
      <div className="bg-canvas px-3 py-6 sm:px-8">
        <article className="mx-auto max-w-3xl rounded-block bg-paper px-6 pb-12 pt-9 text-ink shadow-pop sm:px-12">
          <Cap>
            {side === "log" ? (
              <>
                Протокол проверки · {CHECK_NAME[data.check]} · диалоги
                {file && <span className="normal-case tracking-normal"> «{file}»</span>} · {day(log?.finishedAt)}
              </>
            ) : (
              `Протокол проверки · ${CHECK_NAME[data.check]} · симуляция · ${day(sim?.finishedAt)}`
            )}
          </Cap>
          <h2 className="mt-3 text-balance text-title font-semibold text-ink">{summarySentence(data, side)}</h2>
          {side === "log" && log && (
            <p className="mt-3 text-read text-ink-2">
              Проверено {log.assessed} из {count(log.sampled, "разговора", "разговоров", "разговоров")}. В{" "}
              {log.withViolations} агент ошибся хотя бы раз, {log.unassessed} проверить не удалось.
            </p>
          )}
          {side === "sim" && sim && (
            <p className="mt-3 text-read text-ink-2">
              Прогон {sim.target} · {sim.version}: проверено {sim.assessed} из{" "}
              {count(sim.dialogs, "разговора", "разговоров", "разговоров")}, ошибка в {sim.withViolations},{" "}
              {sim.unassessed} проверить не удалось.
            </p>
          )}
          <dl className="mt-6 grid grid-cols-2 border-t border-ink sm:grid-cols-4">
            {figures.map(([v, of, l], i) => (
              <div key={l} className={i > 0 ? "border-ink-line pt-3 sm:border-l sm:pl-4" : "pt-3"}>
                <dd
                  className={
                    i === 1
                      ? "font-mono text-count font-medium text-ink-bad"
                      : "font-mono text-count font-medium text-ink"
                  }
                >
                  {v}
                  {of && <span className="ml-1 text-small font-normal text-ink-3">{of}</span>}
                </dd>
                <dt className="mt-0.5 text-small text-ink-3">{l}</dt>
              </div>
            ))}
          </dl>
          {grave && (
            <p className="mt-4 text-read text-ink-2">
              {grave.head} — <b className="whitespace-nowrap font-semibold text-ink">{grave.share}</b>
              {grave.rest}
            </p>
          )}
          {items.map((c, i) => (
            <Section key={c.r.id} c={c} i={i + 1} side={side} />
          ))}
          {!items.length && (
            <p className="mt-10 text-read text-ink-2">
              {(side === "log" ? log?.assessed : sim?.assessed)
                ? "Ошибок не найдено."
                : "Разговоры пока не удалось проверить."}
            </p>
          )}
          <p className="mt-12 border-t border-ink-line pt-4 text-small text-ink-3">
            Счёт «N из M»: M — разговоры, где критерий удалось проверить. Диалоги и симуляция считаются отдельно и не
            складываются. «Без найденных ошибок» не означает, что агент исправен.
          </p>
        </article>
      </div>
    </Sheet>
  );
}
