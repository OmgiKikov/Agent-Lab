import { useState, type ReactNode } from "react";
import { Copy, FileDown, RotateCcw } from "lucide-react";
import { CHECK_NAME } from "../../lab/checks";
import { commonText, commonTitle, type Criterion } from "../../lab/criteria";
import { day, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useDatasets } from "../../lab/datasets";
import {
  copyReport,
  download,
  importantFirst,
  problemsReport,
  reliabilityWord,
  reportFile,
  sourceLabel,
  summarySentence,
  useReportAgent,
} from "../../lab/problemReport";
import { askedOf, type Problems } from "../../lab/problems";
import { inQuotes } from "../../lab/quote";
import { secondOf } from "../../lab/problemStats";
import { seriousOf, severityLines, standingOf } from "../../lab/severity";
import { SeriousTag } from "../../product/Severity";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { checked, violationsOf, type SideKey } from "./model";
import { shareBase } from "../../app/agent";
import { originOf } from "../checks/origin";

const Cap = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-label uppercase tracking-caps text-ink-3">{children}</span>
);

/**
 * One violation of the protocol: its criterion, the kind of error named most often, how often, and the two quotes side
 * by side, the code's and the agent's with the customer's words it answered.
 */
function Section({ c, i, side }: { c: Criterion; i: number; side: SideKey }) {
  const s = c.r[side];
  const e = violationsOf(c, side)[0];
  const common = commonTitle(c, side);
  const second = secondOf(s.examples);
  return (
    <section className="mt-10 break-inside-avoid">
      <div className="grid grid-cols-[28px_minmax(0,1fr)] items-baseline">
        <span className="font-mono text-lead text-ink-3">{i}</span>
        <h3 className="text-balance text-lead font-semibold text-ink">
          {c.name}
          <SeriousTag rule={c.r} paper className="relative -top-px ml-2 align-middle font-normal" />
        </h3>
        {common && <p className="col-start-2 mt-1 text-read text-ink-2">{commonText(common)}</p>}
        <p className="col-start-2 mt-1 text-small text-ink-2">
          Ошибка в{" "}
          <b className="whitespace-nowrap font-semibold text-ink-bad">
            {s.failed} из {checked(s)}
          </b>{" "}
          {plural(checked(s), "разговора", "разговоров", "разговоров")}, где критерий применим.
          {second.checked > 0 && ` Две модели совпали в\u00a0${second.agree} из\u00a0${second.checked}.`}
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
                ? "Цитата из правил не сохранилась."
                : "Цитата из кода не сохранилась."}
          </p>
        </div>
        <div className="border-t border-ink-line p-4 sm:border-l sm:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Cap>Агент ответил</Cap>
            {e && <span className="text-small text-ink-3">{reliabilityWord(e, "people")}</span>}
          </div>
          {e ? (
            <>
              <p className="mt-2.5 inline-block rounded-xl rounded-br-sm bg-paper-well px-3 py-1.5 text-small text-ink-2">
                {askedOf(e)}
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
 * simulation are never in one report. The problems a person marked important come first, then the most frequent, in
 * the order of the copied text; the conversations with a serious error stand under the numbers of the conversations,
 * with whose decision that is. «Скопировать для письма» puts the same on the clipboard formatted and as plain text
 * without Markdown marks, each problem with its link; the downloaded file is Markdown. Both name the agent and the
 * dataset as the sheet does, and wait for the agent's name: every agent's report looks alike.
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
  // The dataset the conversations come from, named as «Итог» names it, on the sheet and in the text alike.
  const logs = useLabState().state?.logs;
  const datasets = useDatasets().data?.datasets ?? [];
  const { dataset } = originOf(undefined, datasets, logs?.datasetId, logs?.file);
  const agent = useReportAgent();
  const sides = (
    [
      ["log", "Разговоры"],
      ["sim", "Симуляция"],
    ] as const
  ).filter(([k]) => (k === "log" ? !!data.log : !!data.sim));
  const [side, setSide] = useState<SideKey>(data.log ? "log" : "sim");
  // In the order the copied text tells them (lab/problemReport, importantFirst), so the sheet and the text agree.
  const byId = new Map(list.map((c) => [c.r.id, c]));
  const items = data.rules
    .filter((r) => r[side].failed > 0)
    .sort(importantFirst(side))
    .flatMap((r) => byId.get(r.id) ?? []);
  const markdown = () =>
    problemsReport(data, shareBase(), side, { filename: dataset || undefined, agent: agent.name ?? undefined });
  const copy = () => copyReport(markdown()).then(() => toast.notify("Отчёт скопирован"), toast.error);
  const log = data.log;
  const sim = data.sim;
  // Serious errors are told of the conversations of the export: the severity of a run's own criteria is not proposed.
  const standing = side === "log" && log?.assessed ? standingOf(data) : null;
  const severity = standing ? severityLines(standing, seriousOf(data), "people") : [];
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
      sub="Так он будет выглядеть в письме или тикете"
      actions={
        <>
          {sides.length > 1 && (
            <Segmented<SideKey>
              size="sm"
              label="Что в отчёте"
              value={side}
              onChange={setSide}
              options={sides.map(([k, l]) => ({ value: k, label: l }))}
            />
          )}
          <Button
            variant="ghost"
            icon={FileDown}
            aria-label="Скачать Markdown"
            disabled={!agent.name}
            onClick={() => download(reportFile(`otchet-${side === "log" ? "dialogi" : "simulyaciya"}`), markdown())}
          />
          <Button variant="primary" icon={Copy} disabled={!agent.name} onClick={copy}>
            Скопировать для письма
          </Button>
        </>
      }
    >
      <div className="bg-canvas px-3 py-6 sm:px-8">
        {agent.failed && (
          <div className="mx-auto mb-4 max-w-3xl">
            <p role="alert" className="text-read text-fg-2">
              Не удалось загрузить имя агента.
            </p>
            <Button className="mt-3" icon={RotateCcw} onClick={agent.retry}>
              Повторить
            </Button>
          </div>
        )}
        <article className="mx-auto max-w-3xl rounded-block bg-paper px-6 pb-12 pt-9 text-ink shadow-pop sm:px-12">
          <Cap>
            {agent.name && <span className="normal-case tracking-normal">{agent.name} · </span>}
            {side === "log" ? (
              <>
                {CHECK_NAME[data.check]} · датасет
                {dataset && <span className="normal-case tracking-normal"> {inQuotes(dataset)}</span>} ·{" "}
                {day(log?.finishedAt)}
              </>
            ) : (
              `${CHECK_NAME[data.check]} · симуляция · ${day(sim?.finishedAt)}`
            )}
          </Cap>
          <h2 className="mt-3 text-balance text-title font-semibold text-ink">{summarySentence(data, side)}</h2>
          {side === "sim" && sim && (
            <p className="mt-3 text-read text-ink-2">
              Прогон {sim.target} · {sim.version}
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
          {severity.length > 0 && (
            <div className="mt-4 space-y-1 text-read text-ink-2">
              {severity.map((line, i) =>
                line.kind === "count" ? (
                  <p key={i}>
                    {line.head} — <b className="whitespace-nowrap font-semibold text-ink">{line.share}</b>.
                  </p>
                ) : (
                  <p key={i}>{line.text}</p>
                ),
              )}
            </div>
          )}
          {items.map((c, i) => (
            <Section key={c.r.id} c={c} i={i + 1} side={side} />
          ))}
          {!items.length && (
            <p className="mt-10 text-read text-ink-2">
              {(side === "log" ? log?.assessed : sim?.assessed)
                ? "Ошибок не нашли."
                : "Разговоры пока не удалось проверить."}
            </p>
          )}
          <p className="mt-12 border-t border-ink-line pt-4 text-small text-ink-3">
            В счёте «N из M» M — проверенные разговоры, где критерий применим. Разговоры датасета и симуляция считаются
            отдельно, их числа не складываются. «Без найденных ошибок» не значит, что ошибок нет.
          </p>
        </article>
      </div>
    </Sheet>
  );
}
