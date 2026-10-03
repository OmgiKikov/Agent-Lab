import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";
import { HISTORY_SHOWN } from "../app/product";
import { SECTIONS } from "../app/links";
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

/** A new export replaces the current result and scenarios (backend: store.replace_inputs), so it is asked first. */
export const replacesResult = (state: LabState | null) => !!state?.discover;

/**
 * What a new export takes away, said before it happens — the same words in «Материалы» and «Диалоги». The criteria and
 * the person's clarifications stay for the new export; the result does not.
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
        Итог текущей проверки уйдёт из «Диалогов» и «Обзора»: новые разговоры нужно будет проверить заново.
        {HISTORY_SHOWN
          ? " Сама проверка останется в истории."
          : " Если итог ещё нужен, сначала скачайте «Отчёт для письма»."}
        {keepsCriteria && " Критерии и ваши уточнения сохранятся."}
      </p>
    </Modal>
  );
}

/** Sends the chat's export to the service and says what to do next. */
function useUpload() {
  const { refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const send = async (file: File) => {
    setBusy(true);
    try {
      const { total } = await upload<{ total: number }>("/api/logs", file);
      await refresh();
      // What to measure on them is chosen at the start: tone of voice or the criteria from the agent's code.
      toast.notify(`Загружено ${count(total, "разговор", "разговора", "разговоров")}`, {
        label: "Оценить",
        run: () => {
          void navigate(SECTIONS.start);
        },
      });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

/** «Загрузить диалоги»: the chat's Excel export (sheet «Данные») or prepared .jsonl. */
export function UploadButton({
  variant = "primary",
  label = "Загрузить диалоги",
}: {
  variant?: "primary" | "outline";
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { state } = useLabState();
  const toast = useToast();
  const { busy, send } = useUpload();
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
