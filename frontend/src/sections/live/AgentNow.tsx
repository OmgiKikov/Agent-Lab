import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { liveLink, scenariosLink, SECTIONS, stageLink, type Check } from "../../app/links";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { latestOnResult, latestReplay, replayOnResult } from "../../lab/replays";
import { Button, buttonClass } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { ChangeLine, ReplayNumbers, replayMeta, VerdictLine } from "./ReplayNumbers";
import { ReplaySheet } from "./ReplaySheet";

/** A card of the section: its name, what it is, and its own numbers or its way forward. */
function Card({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-block border border-line p-5">
      <h3 className="text-count font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-body text-fg-3">{about}</p>
      <div className="mt-5 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

const more = "mt-auto inline-flex items-center gap-1 pt-5 text-body font-medium text-run hover:underline";

/** The live agent on the customers of the check's result: its pairs in numbers, or how to get them. */
function LiveCard({ check }: { check: Check }) {
  const { state } = useLabState();
  const [starting, setStarting] = useState(false);
  const latest = latestReplay(state, check);
  const done = replayOnResult(state, check);
  const running = latest?.status === "running" ? latest : null;
  // The newest check on this result that did not run to its end: it says why, and is no result to show.
  const cut = latestOnResult(state, check);
  const broken = cut && (cut.status === "failed" || cut.status === "stopped") && cut !== done ? cut : null;
  const ready = !!state?.targets.some((t) => t.ready);
  const busy = !!state?.job.running;
  return (
    <Card
      title="Живой агент на тех же клиентах"
      about="Синтетический клиент начинает настоящей первой репликой и добивается того же. Тот же судья, те же критерии."
    >
      {running ? (
        <>
          <p className="text-read text-run" role="status">
            Идёт проверка: {running.done} из {count(running.size, "разговора", "разговоров", "разговоров")}
          </p>
          <Link to={liveLink(check)} className={more}>
            Смотреть пары
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : broken && (!done || broken.startedAt > done.startedAt) ? (
        <>
          <p className="text-read text-fg-2">
            {broken.status === "stopped" ? "Последняя проверка остановлена" : "Последняя проверка не удалась"}
            {broken.error ? `: ${broken.error}` : "."}
          </p>
          <p className="mt-2 text-small text-fg-3">{replayMeta(broken)}</p>
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-5">
            <Button disabled={busy || !ready} onClick={() => setStarting(true)}>
              Проверить снова
            </Button>
            <Link to={liveLink(check, { id: broken.id })} className="text-body text-run hover:underline">
              Что успели
            </Link>
          </div>
        </>
      ) : done ? (
        <>
          <ReplayNumbers r={done} size="card" />
          <ChangeLine r={done} className="mt-2 text-small" />
          <VerdictLine r={done} className="mt-1 text-small" />
          <p className="mt-2 text-small text-fg-3">{replayMeta(done)}</p>
          <Link to={liveLink(check, { id: done.id })} className={more}>
            Открыть пары
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : (
        <>
          <p className="text-read text-fg-2">
            {latest
              ? "Последняя проверка была на прошлом итоге. Проверьте агента на клиентах этого."
              : "Проверьте, как агент отвечает сейчас тем же клиентам, что в записях."}
          </p>
          {!ready && (
            <p className="mt-2 text-small text-fg-3">
              Сначала подключите агента в{" "}
              <Link to={SECTIONS.agent} className="underline underline-offset-4">
                «Агенте»
              </Link>
              .
            </p>
          )}
          <div className="mt-auto pt-5">
            <Button disabled={busy || !ready} onClick={() => setStarting(true)}>
              Проверить живого агента
            </Button>
          </div>
        </>
      )}
      <ReplaySheet check={check} open={starting} onClose={() => setStarting(false)} />
    </Card>
  );
}

/** The scenarios built from the errors of this check: the last run of them, or how to get one. */
function ScenarioCard({ check }: { check: Check }) {
  const { state } = useLabState();
  const runs = (state?.runs ?? []).filter((r) => r.check === check && r.status !== "running" && r.metric?.measured);
  const run = runs[0];
  const deck = state?.cards?.check === check ? state.cards.cards.length : 0;
  return (
    <Card
      title="В сценариях из ошибок"
      about="Синтетические клиенты разыгрывают с агентом сценарии, собранные из найденных ошибок. Свои числа: сценарии нарочно трудные."
    >
      {run?.metric ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-count font-semibold tabular-nums text-bad">{run.metric.failed}</span>
            <span className="text-read text-fg-3">
              из {run.metric.measured} {plural(run.metric.measured, "разговора", "разговоров", "разговоров")} с ошибкой
              агента
            </span>
          </p>
          <p className="mt-2 text-small text-fg-3">
            {[
              run.targetName,
              run.version && run.version !== "…" ? `версия ${run.version}` : null,
              `прогон ${longDay(run.startedAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <Link to={stageLink("sim", run.id)} className={more}>
            Открыть симуляции
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </>
      ) : deck ? (
        <>
          <p className="text-read text-fg-2">
            {count(deck, "сценарий собран", "сценария собраны", "сценариев собрано")} из ошибок этой проверки, ещё не
            сыграны.
          </p>
          <div className="mt-auto pt-5">
            <Link to={`${SECTIONS.simulations}?play=1`} className={buttonClass()}>
              Сыграть сценарии
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="text-read text-fg-2">
            Из ошибок этой проверки можно собрать сценарии для синтетических клиентов.
          </p>
          <div className="mt-auto pt-5">
            <Link to={scenariosLink()} className={buttonClass()}>
              К сценариям
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * «Агент сейчас» under a check's result: the recordings say how the agent answered then; here, how it answers now —
 * the same customers, and the scenarios built from its errors. Each with its own numbers: they never add up.
 */
export function AgentNow({ check }: { check: Check }) {
  return (
    <section aria-labelledby="agent-now" className="mt-16">
      <div className="border-b border-line pb-3">
        <Label id="agent-now">Агент сейчас</Label>
        <p className="mt-1 max-w-[70ch] text-body text-fg-3">
          Итог выше — по записанным разговорам. Здесь — как агент отвечает сейчас. У каждой проверки свои разговоры и
          свои числа, они не складываются.
        </p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <LiveCard check={check} />
        <ScenarioCard check={check} />
      </div>
    </section>
  );
}
