import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Upload, X } from "lucide-react";
import { launchLink, type Check } from "../app/links";
import { upload } from "../lab/api";
import { count, plural } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { ExportFormat } from "./ExportFormat";
import { useToast } from "../ui/toast";

const ACCEPT = ".xlsx,.jsonl,.json,.csv";

/** The export reader takes the chat's Excel or a prepared .jsonl: anything else is refused before a question is asked. */
export const exportFileError = (file: File) => {
  if (!/\.(xlsx|jsonl|json|csv)$/i.test(file.name))
    return "Этот файл не подходит. Загрузите датасет в XLSX, JSONL, JSON или CSV.";
  if (!file.size) return "Файл пустой. Выберите файл с разговорами.";
  if (file.size > 50_000_000) return "Файл больше 50 МБ. Выгрузите разговоры за меньший срок.";
  return null;
};

/**
 * One upload flow wherever conversations are added: pick, inspect the file and its consequences, upload. The name
 * and the version of the agent whose answers the file holds are the person's to give, both optional. `short`: the
 * label a phone shows, where the whole one does not fit beside the page's title.
 */
export function UploadButton({
  variant = "primary",
  size = "md",
  label = "Загрузить датасет",
  short,
  check,
  disabled = false,
  onLoaded,
}: {
  variant?: "primary" | "outline";
  size?: "sm" | "md";
  label?: string;
  short?: string;
  check?: Check;
  disabled?: boolean;
  /** After the export is read: the page shows what came, such as «Датасеты» the new dataset. */
  onLoaded?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const { state, refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [datasetName, setDatasetName] = useState("");
  const [agentVersion, setAgentVersion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const running = !!state?.job.running || disabled;
  // A dataset in work already: the new one comes beside it, the one before and its checks stay.
  const previous = !!state?.logs.total;
  const pick = (files: File[]) => {
    if (lock.current || running) return;
    if (files.length !== 1) {
      setError("Выберите один файл датасета.");
      return;
    }
    const wrong = exportFileError(files[0]);
    setError(wrong ?? "");
    setFile(wrong ? null : files[0]);
  };
  const send = async () => {
    if (!file || lock.current || running) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const { total, skipped = 0 } = await upload<{ total: number; skipped?: number }>("/api/logs", file, {
        ...(datasetName.trim() ? { title: datasetName.trim() } : {}),
        ...(agentVersion.trim() ? { agentVersion: agentVersion.trim() } : {}),
      });
      await refresh();
      setOpen(false);
      setFile(null);
      setDatasetName("");
      setAgentVersion("");
      onLoaded?.();
      const next = check ? launchLink(check) : null;
      const left = skipped
        ? `. Ещё ${count(skipped, "разговор не загружен", "разговора не загружены", "разговоров не загружены")}: ${plural(skipped, "в нём", "в них", "в них")} первым пишет агент или он не отвечает.`
        : "";
      toast.notify(
        `Загружено ${count(total, "разговор", "разговора", "разговоров")}${left}`,
        next
          ? {
              label: "Проверить",
              run: () => {
                void navigate(next);
              },
            }
          : undefined,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        ref={trigger}
        aria-label={short ? label : undefined}
        variant={variant}
        size={size}
        icon={Upload}
        disabled={running}
        title={running ? "Дождитесь завершения текущей задачи" : undefined}
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        {short ? (
          <>
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </Button>
      <Modal
        open={open}
        onClose={() => {
          if (!lock.current) setOpen(false);
        }}
        title="Загрузить датасет"
        onCloseAutoFocus={(event) => {
          if (trigger.current?.isConnected) {
            event.preventDefault();
            trigger.current.focus();
          }
        }}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button variant="primary" loading={busy} disabled={!file || running} onClick={send}>
              {busy ? "Загружаем…" : "Загрузить"}
            </Button>
          </>
        }
      >
        {previous && (
          <p className="mb-5 text-read text-fg-3">
            Новый датасет сохранится рядом с предыдущими и станет выбранным для проверки.
          </p>
        )}
        <label className="mb-4 block text-body font-medium text-fg">
          Название датасета <span className="font-normal text-fg-3">· по желанию</span>
          <Input
            value={datasetName}
            onChange={(event) => setDatasetName(event.target.value)}
            maxLength={160}
            disabled={busy}
            placeholder={file?.name || "Например: Разговоры за октябрь"}
            className="mt-2"
          />
        </label>
        <label className="mb-4 block text-body font-medium text-fg">
          Версия агента в этом датасете <span className="font-normal text-fg-3">· по желанию</span>
          <Input
            value={agentVersion}
            onChange={(event) => setAgentVersion(event.target.value)}
            maxLength={80}
            disabled={busy}
            placeholder="Например, v2.4"
            className="mt-2"
          />
          <span className="mt-1.5 block text-small font-normal text-fg-3">
            Какая версия агента дала эти ответы. Она будет видна в итоге и в истории.
          </span>
        </label>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          aria-label="Файл датасета"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) pick(files);
          }}
        />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy && !running) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(Array.from(e.dataTransfer.files));
          }}
          className={`rounded-block border border-dashed p-6 text-center transition-colors ${over ? "border-run bg-run/5" : "border-line-strong bg-inset/50"}`}
        >
          {file ? (
            <div className="flex items-center gap-3 text-left">
              <FileText aria-hidden className="size-6 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <p className="break-all text-body font-medium text-fg">{file.name}</p>
                <p className="mt-1 text-small text-fg-3">
                  {Math.max(1, Math.round(file.size / 1024)).toLocaleString("ru-RU")} КБ · готов к загрузке
                </p>
              </div>
              <Button
                variant="ghost"
                icon={X}
                aria-label="Убрать выбранный файл"
                disabled={busy}
                onClick={() => setFile(null)}
              />
            </div>
          ) : (
            <>
              <Upload aria-hidden className="mx-auto mb-3 size-6 text-fg-3" />
              <p className="text-read font-medium text-fg">Перетащите файл датасета сюда</p>
              <p className="mt-1 text-small text-fg-3">XLSX, JSONL, JSON или CSV · до 50 МБ</p>
              <Button className="mt-4" disabled={busy || running} onClick={() => input.current?.click()}>
                Выбрать файл
              </Button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded-control bg-bad/5 p-3 text-body text-bad">
            {error}
          </p>
        )}
        {running && (
          <p role="status" className="mt-4 text-body text-warn">
            Сейчас идёт другая задача. Загрузка станет доступна после её завершения.
          </p>
        )}
        {/* Nothing is lost by a new dataset (backend: store.replace_inputs): the current results go to the history of
            their checks, the criteria and people's answers stay with the saved checks they were given on. */}
        {previous && (
          <div className="mt-4 rounded-control bg-inset p-4 text-small text-fg-2">
            <p className="font-medium text-fg">Предыдущий датасет и его результаты останутся доступны.</p>
            <p className="mt-2">
              Прошлые проверки сохранят свои разговоры и критерии. Вернуться к прежнему датасету можно в разделе
              «Датасеты».
            </p>
          </div>
        )}
        <div className="mt-4">
          <ExportFormat />
        </div>
      </Modal>
    </>
  );
}
