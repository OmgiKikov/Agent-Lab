import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";
import { SECTIONS, toneCheckLink, type Check } from "../app/links";
import { upload } from "../lab/api";
import { count } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import type { LabState } from "../lab/types";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/toast";

const ACCEPT = ".xlsx,.jsonl";

/** The export reader takes the chat's Excel or a prepared .jsonl: anything else is refused before a question is asked. */
export const exportFileError = (file: File) =>
  /\.(xlsx|jsonl)$/i.test(file.name) ? null : "Загрузите выгрузку чата: файл .xlsx или .jsonl.";

/**
 * What a new export moves or takes away (backend: store.replace_inputs): the results of both checks and the scenarios.
 * Asked first whenever there is any of them.
 */
export const replacesResult = (state: LabState | null) =>
  !!(state?.checks.tone || state?.checks.code || state?.cards?.cards.length);

/**
 * What a new export does, in the order a person asks about it (backend: store.replace_inputs): the current results go
 * to the history of their checks; the new conversations are checked by the same criteria and compared with the
 * previous ones; the scenarios built from a result are reset, the runs stay; the answers of people stay, with the
 * saved checks they were given on (store.set_log_review).
 */
function whatHappens(state: LabState | null): [string, string] {
  const tone = !!state?.checks.tone;
  const code = !!state?.checks.code;
  const deck = state?.cards?.cards.length ? state.cards : null;
  const results =
    tone && code
      ? "Текущие итоги tone of voice и точности уйдут в «Историю». "
      : tone
        ? "Текущий итог tone of voice уйдёт в «Историю». "
        : code
          ? "Текущий итог точности уйдёт в «Историю». "
          : "";
  const stays = "прогоны симуляций и ответы людей останутся.";
  return [
    `${results}Новые разговоры проверяются по тем же критериям и сравниваются с прошлыми.`,
    deck
      ? `Сценарии, собранные из итога ${deck.check === "tone" ? "tone of voice" : "точности"}, сбросятся; ${stays}`
      : stays.charAt(0).toUpperCase() + stays.slice(1),
  ];
}

/**
 * The question before a new export, the same wherever the export is loaded: what goes to «История», what is compared,
 * what is reset and what stays.
 */
export function ReplaceExport({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { state } = useLabState();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Загрузить новую выгрузку?"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Загрузить
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-read text-fg-2">
        {whatHappens(state).map((text) => (
          <p key={text}>{text}</p>
        ))}
      </div>
    </Modal>
  );
}

/** Sends the chat's export to the service and offers the check of the page it was loaded from. */
function useUpload(check?: Check) {
  const { refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const send = async (file: File) => {
    setBusy(true);
    try {
      const { total } = await upload<{ total: number }>("/api/logs", file);
      await refresh();
      const next = check === "code" ? `${SECTIONS.accuracy}?assess=1` : check === "tone" ? toneCheckLink() : null;
      toast.notify(
        `Загружено ${count(total, "разговор", "разговора", "разговоров")}`,
        next
          ? {
              label: "Проверить",
              run: () => {
                void navigate(next);
              },
            }
          : undefined,
      );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

/** «Загрузить диалоги»: the chat's Excel export (sheet «Данные») or prepared .jsonl, shared by both checks. */
export function UploadButton({
  variant = "primary",
  label = "Загрузить диалоги",
  check,
}: {
  variant?: "primary" | "outline";
  label?: string;
  /** The check whose page it is on: after the upload, the way to check the new conversations by it. */
  check?: Check;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { state } = useLabState();
  const toast = useToast();
  const { busy, send } = useUpload(check);
  const [pending, setPending] = useState<File | null>(null);
  const running = !!state?.job.running;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const wrong = exportFileError(f);
          if (wrong) toast.error(wrong);
          else if (replacesResult(state)) setPending(f);
          else void send(f);
        }}
      />
      <Button
        variant={variant}
        icon={Upload}
        loading={busy}
        disabled={running}
        title={running ? "Сейчас идёт другая задача" : "Excel-выгрузка чата или .jsonl"}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      <ReplaceExport
        open={!!pending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const f = pending;
          setPending(null);
          if (f) void send(f);
        }}
      />
    </>
  );
}
