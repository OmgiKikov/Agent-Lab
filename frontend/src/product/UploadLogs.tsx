import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";
import { SECTIONS } from "../app/links";
import { upload } from "../lab/api";
import { count } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { Button } from "../ui/Button";
import { useToast } from "../ui/toast";

const ACCEPT = ".xlsx,.jsonl";

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
  const { busy, send } = useUpload();
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
          if (f) send(f);
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
    </>
  );
}
