import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Play } from "lucide-react";
import { api } from "../../lab/api";
import { plural } from "../../lab/format";
import type { RuleEntry } from "../../lab/problems";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Menu } from "../../ui/Menu";
import { useToast } from "../../ui/toast";

const TARGET_KEY = "lab.target";
const readTarget = () => { try { return localStorage.getItem(TARGET_KEY); } catch { return null; } };
const link = "text-lab-ink underline decoration-white/30 underline-offset-4";

/** Play the scenarios built from this problem's conversations again, on the agent of your choice. */
export function Reproduce({ p }: { p: RuleEntry }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const ready = (state?.targets ?? []).filter(t => t.ready);
  const [target, setTarget] = useState(readTarget);
  const [starting, setStarting] = useState(false);
  const chosen = ready.find(t => t.id === target) ?? ready[0];
  const busy = !!state?.job.running;
  const n = p.scenarioIds.length;
  const start = async () => {
    if (!chosen) return;
    setStarting(true);
    try {
      await api("/api/runs", { target: chosen.id, cardIds: p.scenarioIds, label: `Воспроизвести: ${p.title}`.slice(0, 120), repeats: 1, personas: ["default"] });
      try { localStorage.setItem(TARGET_KEY, chosen.id); } catch { /* private mode */ }
      toast.notify(`Сценарии играются на агенте «${chosen.name}»`);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className="mt-10">
      <Label>Воспроизвести</Label>
      {n ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-small text-lab-mute">
            Из этих диалогов {plural(n, "собран", "собрано", "собрано")} {n} {plural(n, "сценарий", "сценария", "сценариев")} симулятора.
          </p>
          {chosen ? (
            <>
              <Menu
                trigger={<span className="inline-flex h-8 items-center gap-1 rounded-md border border-white/[0.12] px-3 text-small text-lab-soft transition-colors hover:border-white/25">Агент: {chosen.name}<ChevronDown className="size-3.5" /></span>}
                items={ready.map(t => ({ key: t.id, label: t.name, sub: t.where || t.note, on: t.id === chosen.id, run: () => setTarget(t.id) }))}
              />
              <Button icon={Play} onClick={start} loading={starting} disabled={busy} title={busy ? "Сейчас идёт другая задача" : undefined}>Сыграть</Button>
            </>
          ) : <Link to={LINKS.agent} className={`text-small ${link}`}>Подключите агента</Link>}
        </div>
      ) : (
        <p className="mt-2 text-small text-lab-mute">Сценарии из этих диалогов не собраны. <Link to={LINKS.scenarios} className={link}>Собрать в «Симуляциях»</Link></p>
      )}
    </section>
  );
}
