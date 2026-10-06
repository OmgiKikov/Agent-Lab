import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { uploadExport } from "../../lab/exports";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import type { ExportLine } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";

const ACCEPT = ".xlsx,.jsonl";
const FIELD =
  "mt-1.5 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-read text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3 disabled:opacity-60";

/** The export reader takes the chat's Excel or a prepared .jsonl: anything else is refused before it is sent. */
export const exportFileError = (file: File) =>
  /\.(xlsx|jsonl)$/i.test(file.name) ? null : "Этот файл не подходит. Загрузите выгрузку чата в .xlsx или .jsonl.";

const stem = (name: string) => name.replace(/\.[^.]+$/, "").trim();

/** What came of a file: its name in the list, how many conversations, and how many were left out and why. */
export function uploadedText(line: ExportLine) {
  const left = line.skipped
    ? ` Ещё ${count(line.skipped, "разговор не загружен", "разговора не загружены", "разговоров не загружены")}: ${plural(line.skipped, "в нём", "в них", "в них")} первым пишет агент или он не отвечает.`
    : "";
  return `Выгрузка «${line.name}»: ${count(line.total, "разговор", "разговора", "разговоров")}.${left}`;
}

/**
 * «Загрузить выгрузку»: the chat's Excel (sheet «Данные») or a prepared .jsonl, under the name it will have in the list
 * and in the results (the file's unless a person writes another). An upload adds an export beside the others and
 * changes nothing checked. `open`/`onOpen`: the window is the page's when it says so (⌘K «Загрузить выгрузку» opens
 * it from the page, and the button may stand in two places of it); else the button's own.
 */
export function UploadExport({
  variant = "primary",
  label = "Загрузить выгрузку",
  open: shown,
  onOpen,
  onUploaded,
}: {
  variant?: "primary" | "outline";
  label?: string;
  open?: boolean;
  onOpen?: (open: boolean) => void;
  onUploaded?: (line: ExportLine) => void;
}) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = (value: boolean) => (onOpen ? onOpen(value) : setOwn(value));
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = !!state?.job.running;
  const close = () => {
    if (busy) return;
    setOpen(false);
    setFile(null);
    setName("");
    setNamed(false);
    setError(null);
  };
  const send = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const line = await uploadExport(file, name.trim());
      await refresh();
      setBusy(false);
      close();
      toast.notify(uploadedText(line));
      onUploaded?.(line);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant={variant}
        icon={Upload}
        disabled={running}
        title={running ? "Сейчас идёт другая задача" : undefined}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Новая выгрузка"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!file || !name.trim() || running}
              title={running ? "Сейчас идёт другая задача" : undefined}
              onClick={() => void send()}
            >
              Загрузить
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-label="Файл выгрузки"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const wrong = exportFileError(f);
              setError(wrong);
              if (wrong) return;
              setFile(f);
              if (!named) setName(stem(f.name));
            }}
          />
          <div className="flex items-center gap-3 rounded-block bg-inset px-4 py-3">
            <FileSpreadsheet aria-hidden className="size-5 flex-shrink-0 text-fg-3" strokeWidth={1.6} />
            <p className="min-w-0 flex-1 break-words text-body text-fg-2">
              {file ? file.name : "Excel-выгрузка чата (лист «Данные») или .jsonl"}
            </p>
            <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
              {file ? "Другой файл" : "Выбрать файл"}
            </Button>
          </div>
          <label className="block text-body font-medium text-fg">
            Название
            <input
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                setNamed(true);
              }}
              placeholder="Например: Сентябрь"
              className={FIELD}
            />
          </label>
          <p className="text-small text-fg-3">
            Так выгрузка будет называться в списке и в итогах проверок. Уже проверенное не изменится.
          </p>
          {error && (
            <p role="alert" className="text-small text-bad">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
