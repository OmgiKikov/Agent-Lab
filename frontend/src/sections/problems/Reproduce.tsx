import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Play } from "lucide-react";
import { api } from "../../lab/api";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { scenariosLink, SECTIONS, type Check } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Menu } from "../../ui/Menu";
import { useToast } from "../../ui/toast";
import { agentKey } from "../../app/agent";

const TARGET_KEY = agentKey("lab.target");
const readTarget = () => {
  try {
    return localStorage.getItem(TARGET_KEY);
  } catch {
    return null;
  }
};
const link = "rounded-sm text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3";

/**
 * Play again the scenarios built from this violation's conversations, on the agent of your choice; the run shows in the
 * task card. Only the scenarios of this check count: a deck built from the other check's errors is not this one's.
 */
export function Reproduce({ r, check }: { r: RuleEntry; check: Check }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const ready = (state?.targets ?? []).filter((t) => t.ready);
  const [target, setTarget] = useState(readTarget);
  const [starting, setStarting] = useState(false);
  const chosen = ready.find((t) => t.id === target) ?? ready[0];
  const busy = !!state?.job.running;
  const ids = state?.cards?.check === check ? r.scenarioIds : [];
  const n = ids.length;
  const start = async () => {
    if (!chosen) return;
    setStarting(true);
    try {
      await api("/api/runs", {
        target: chosen.id,
        cardIds: ids,
        label: `Воспроизвести: ${r.title}`.slice(0, 120),
        repeats: 1,
        personas: ["default"],
      });
      try {
        localStorage.setItem(TARGET_KEY, chosen.id);
      } catch {
        /* private mode */
      }
      toast.notify(`Прогон запущен с агентом «${chosen.name}»`);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <section id="reproduce" aria-label="Проверить в симуляции" className="scroll-mt-4">
      <Label>Проверить в симуляции</Label>
      {n ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-body text-fg-2">
          <span>
            Из этих разговоров {plural(n, "собран", "собрано", "собрано")} {n}
            {"\u00a0"}
            {plural(n, "сценарий", "сценария", "сценариев")}. Синтетический клиент сыграет их с агентом.
          </span>
          {chosen ? (
            <span className="flex items-center gap-2">
              <Menu
                trigger={
                  <span className="inline-flex h-8 items-center gap-1 rounded-control border border-line-strong px-3 text-small text-fg-2 transition-colors hover:text-fg">
                    Агент: {chosen.name}
                    <ChevronDown aria-hidden className="size-3.5" />
                  </span>
                }
                items={ready.map((t) => ({
                  key: t.id,
                  label: t.name,
                  sub: t.where || t.note,
                  on: t.id === chosen.id,
                  run: () => setTarget(t.id),
                }))}
              />
              <Button
                icon={Play}
                onClick={start}
                loading={starting}
                disabled={busy}
                title={busy ? "Сейчас идёт другая задача" : undefined}
              >
                Сыграть
              </Button>
            </span>
          ) : (
            <Link to={SECTIONS.agent} className={link}>
              Подключите агента
            </Link>
          )}
        </div>
      ) : (
        <p className="mt-2 text-body text-fg-2">
          Сценарии из этих разговоров ещё не собраны.{" "}
          <Link to={scenariosLink()} className={link}>
            Собрать в «Симуляциях»
          </Link>
        </p>
      )}
    </section>
  );
}
