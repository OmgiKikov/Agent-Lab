import { useState } from "react";
import { Play } from "lucide-react";
import { api } from "./api";
import { count, plural } from "./format";
import { DEFAULT_PERSONA } from "./look";
import { useToast } from "./toast";
import type { LabState } from "./types";
import { Button, Field, Input, Label, PersonaCard, Segmented } from "./ui";

/** «Проверить версию»: which agent, who writes to it, how many times, and what changed. The footer says how many dialogues it makes. */
export function NewRun({ state, target, setTarget, onStarted }: { state: LabState; target: string; setTarget: (t: string) => void; onStarted?: () => void }) {
  const { error } = useToast();
  const deck = state.cards?.cards ?? [];
  const [repeats, setRepeats] = useState(1);
  const [types, setTypes] = useState<string[]>([DEFAULT_PERSONA]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setTypes(t => t.includes(id) ? (t.length > 1 ? t.filter(x => x !== id) : t) : [...t, id]);
  const start = () => {
    setBusy(true);
    api("/api/runs", { target, repeats, personas: types, label: label.trim() }).then(() => onStarted?.()).catch(error).finally(() => setBusy(false));
  };
  const total = deck.length * types.length * repeats;
  const note = state.targets.find(t => t.id === target)?.note;
  return (
    <div>
      <div className="space-y-6 px-6 pb-6 pt-2">
        <Field label="Что изменили в этой версии" hint="Подпись версии в списке версий. Можно оставить пустой.">
          <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} placeholder="Например: тариф запрашивается до ответа о комиссии" />
        </Field>
        <div>
          <Label className="mb-2">Агент</Label>
          <Segmented value={target} onChange={setTarget} options={state.targets.map(t => ({ value: t.id, label: t.name, title: t.note }))} />
          {note && <p className="mt-1.5 text-caption text-lab-mute">{note}</p>}
        </div>
        <div>
          <Label className="mb-2">Кто пишет агенту</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {state.personas.map(p => <PersonaCard key={p.id} persona={p} on={types.includes(p.id)} onClick={() => toggle(p.id)} />)}
          </div>
        </div>
        <div>
          <Label className="mb-2">Повторы</Label>
          <Segmented value={repeats} onChange={setRepeats} options={[1, 2, 3].map(n => ({ value: n, label: n === 1 ? "Один раз" : `${n} раза` }))} />
          <p className="mt-1.5 text-caption text-lab-mute">Повторы показывают, одинаково ли агент отвечает на один и тот же сценарий.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-lab-line px-6 py-4">
        {deck.length ? (
          <span className="text-body tabular-nums text-lab-mute">
            {count(deck.length, "сценарий", "сценария", "сценариев")} × {types.length} {plural(types.length, "тип", "типа", "типов")}{repeats > 1 ? ` × ${repeats}` : ""} = <b className="font-medium text-lab-ink">{count(total, "диалог", "диалога", "диалогов")}</b>
          </span>
        ) : (
          <span className="text-body text-lab-warn">Играть пока нечего: сначала соберите сценарии.</span>
        )}
        <Button variant="primary" icon={Play} loading={busy} disabled={state.job.running || !deck.length} onClick={start}>Запустить проверку</Button>
      </div>
    </div>
  );
}
