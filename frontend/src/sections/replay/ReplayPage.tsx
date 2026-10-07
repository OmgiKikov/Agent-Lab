import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Repeat } from "lucide-react";
import { Header } from "../../app/Header";
import { SECTIONS } from "../../app/links";
import { SectionJob } from "../../app/SectionJob";
import { api } from "../../lab/api";
import { count, longDay, pct, time } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { FAMILY_NAME, useReplay } from "../../lab/replay";
import type { Family, FamilyScore, ReplayDialogue, ReplayResult, Target } from "../../lab/types";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { Dot, dotOf } from "../simulations/parts";
import { KnowledgeBase } from "./KnowledgeBase";
import { StepView } from "./StepView";

const MAX_COUNT = 200;

/** Tone and prompts keep one number each; the knowledge base has its own block (KnowledgeBase). */
const SCORED: Family[] = ["tone", "code"];

const FIELD =
  "mt-1 block rounded-control border border-line bg-canvas px-3 py-2 text-body text-fg outline-none focus-visible:ring-2 focus-visible:ring-run";

const LINK = "rounded-sm text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3";

/** The replay service on the stand first: it replays the agent as production runs it. */
const defaultTarget = (targets: Target[]) =>
  (targets.find((t) => t.kind === "replay") ?? targets.find((t) => t.kind === "code") ?? targets[0])?.id ?? "";

/**
 * «Повтор разговоров»: conversations of the export play again through an agent that gives its trace: the replay service
 * on the stand or the local agent, a step for every customer message.
 * Each step shows production's reply beside the new one, what the agent looked up and the verdicts on the new reply.
 */
export function ReplayPage() {
  const { state, offline } = useLabState();
  const replay = useReplay(state);
  const result = replay.data && "id" in replay.data ? replay.data : null;
  const header = (
    <Header
      title="Повтор разговоров"
      sub="Разговоры из выгрузки проходят через агента заново"
      below={<SectionJob kinds={["replay"]} />}
    />
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1040px] space-y-8 px-4 pb-24 pt-8 lg:px-10">
          <StartForm />
          {result ? (
            <Result result={result} />
          ) : replay.isError ? (
            <EmptyState title="Не удалось прочитать повтор">{replay.error.message}</EmptyState>
          ) : state?.replay ? (
            <Skeleton className="h-36" />
          ) : (
            <EmptyState title="Здесь будут повторённые разговоры">Выберите агента и запустите повтор.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function StartForm() {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const targets = state?.replayTargets ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [dialogues, setDialogues] = useState(10);
  const target = targets.some((t) => t.id === picked) ? (picked ?? "") : defaultTarget(targets);
  const busy = !!state?.job.running;
  const busyTitle = state?.job.kind === "replay" ? "Повтор уже идёт" : "Сейчас идёт другая задача";
  const valid = Number.isInteger(dialogues) && dialogues >= 1 && dialogues <= MAX_COUNT;

  const start = () => {
    api("/api/replay", { target, count: dialogues })
      .then(() => refresh())
      .catch(toast.error);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      {targets.length ? (
        <label className="text-small text-fg-3">
          Агент
          <select className={FIELD} value={target} onChange={(e) => setPicked(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="w-full text-body text-fg-2">
          Нет агента, который отдаёт трейс. Задайте адрес сервиса повтора в LAB_REPLAY_URL или{" "}
          <Link to={SECTIONS.agent} className={LINK}>
            настройте агента на этом компьютере
          </Link>
          .
        </p>
      )}
      <label className="text-small text-fg-3">
        Разговоров
        <input
          type="number"
          min={1}
          max={MAX_COUNT}
          className={`${FIELD} w-24 tabular-nums`}
          value={dialogues}
          onChange={(e) => setDialogues(Number(e.target.value))}
        />
      </label>
      <Button
        variant="primary"
        icon={Repeat}
        onClick={start}
        disabled={!target || !valid || busy}
        title={busy ? busyTitle : undefined}
      >
        Повторить
      </Button>
    </div>
  );
}

function Result({ result }: { result: ReplayResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const versionName = result.stand?.prompts ? "промпты" : "версия агента";
  return (
    <div className="space-y-6">
      <p className="text-small text-fg-3">
        Повтор {longDay(result.finishedAt)} в {time(result.finishedAt)} · {versionName} {result.version || "—"}
        {result.stand?.idpCache &&
          ` · кэш базы знаний: ${result.stand.idpCache.warmed} из ${result.stand.idpCache.total}`}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SCORED.map((family) => (
          <Score key={family} name={FAMILY_NAME[family]} score={result.metric[family]} />
        ))}
      </div>
      <KnowledgeBase result={result} />
      <ul>
        {result.dialogues.map((d) => (
          <Dialogue
            key={d.dialogueId}
            dialogue={d}
            open={open === d.dialogueId}
            onToggle={() => setOpen(open === d.dialogueId ? null : d.dialogueId)}
          />
        ))}
      </ul>
    </div>
  );
}

function Score({ name, score }: { name: string; score: FamilyScore }) {
  const total = score.pass + score.fail;
  return (
    <div className="rounded-control border border-line p-3">
      <div className="text-small text-fg-3">{name}</div>
      {total ? (
        <>
          <div className="text-title font-semibold tabular-nums text-fg">{pct(score.pass, total)}%</div>
          <div className="text-small text-fg-3">
            выполнено {score.pass} из {total}
          </div>
        </>
      ) : (
        <div className="text-body text-fg-3">Не удалось проверить</div>
      )}
    </div>
  );
}

function Dialogue({ dialogue, open, onToggle }: { dialogue: ReplayDialogue; open: boolean; onToggle: () => void }) {
  const stepsId = useId();
  return (
    <li className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={stepsId}
        className="flex w-full items-center gap-2 py-3 text-left text-body text-fg"
        onClick={onToggle}
      >
        <Dot status={dialogue.status} />
        <span className="sr-only">{dotOf(dialogue.status).word}. </span>
        <span className="min-w-0 flex-1 truncate">{dialogue.steps[0]?.customer}</span>
        <span className="text-small text-fg-3">{count(dialogue.steps.length, "шаг", "шага", "шагов")}</span>
      </button>
      <div id={stepsId} hidden={!open}>
        {open && dialogue.steps.map((step) => <StepView key={step.index} step={step} />)}
      </div>
    </li>
  );
}
