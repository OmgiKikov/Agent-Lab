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
 * What a new export takes away (backend: store.replace_inputs): the results of both checks and the scenarios. Asked
 * first whenever there is any of them.
 */
export const replacesResult = (state: LabState | null) =>
  !!(state?.checks.tone || state?.checks.code || state?.cards?.cards.length);

/** «Уйдут итог tone of voice, итог точности и собранные сценарии»: what this export replaces, in one phrase. */
function whatGoes(state: LabState | null) {
  const parts = [
    state?.checks.tone && "итог tone of voice",
    state?.checks.code && "итог точности",
    state?.cards?.cards.length && "собранные сценарии",
  ].filter(Boolean) as string[];
  if (!parts.length) return "";
  const many = parts.length > 1 || !!state?.cards?.cards.length;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}` : parts[0];
  return `${many ? "Уйдут" : "Уйдёт"} ${list}`;
}

/**
 * What a new export takes away, said before it happens — the same words wherever the export is replaced. The
 * criteria and the person's clarifications stay for the new export; the results of both checks do not.
 */
export function ReplaceExport({
  open,
  onCancel,
  onConfirm,
  keepsCriteria,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  keepsCriteria: boolean;
}) {
  const { state } = useLabState();
  const goes = whatGoes(state);
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Заменить выгрузку?"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Заменить
          </Button>
        </>
      }
    >
      <p className="text-read text-fg-2">
        {goes ? `${goes}: новые разговоры нужно будет проверить заново.` : "Новые разговоры нужно будет проверить."}{" "}
        Проверки tone of voice останутся в истории, прогоны симуляций — тоже.
        {keepsCriteria && " Критерии tone of voice и ваши уточнения сохранятся."}
      </p>
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
        keepsCriteria={!!state?.toneOfVoice}
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
