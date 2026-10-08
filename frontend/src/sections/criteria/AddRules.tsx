import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Copy, FileText, Loader2, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTIONS } from "../../app/links";
import { rulesLine } from "../../lab/agents";
import { api, upload } from "../../lab/api";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useSource } from "../../lab/problems";
import { rememberName, rememberText, savedName, savedText, TONE_ID } from "../../lab/tone";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Field";
import { Menu } from "../../ui/Menu";
import { useTakeRules } from "../judges/TakeRules";

const bar = "block h-1.5 rounded-full bg-fg/10";
const CARD = "group relative flex h-full min-h-[224px] w-full flex-col rounded-[18px] bg-inset p-4 text-left";
/** A card that is pressed as a whole: a document to choose, a text to write. */
const PRESS = `${CARD} transition-colors hover:bg-fg/[0.06] focus-within:ring-2 focus-within:ring-run/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60`;

/** A way to give the rules, as «Gather your ideas» shows a kind of thing: a word on it, its name, a glimpse, a «+». */
function Way({
  kicker,
  title,
  plus = true,
  children,
}: {
  kicker: string;
  title: string;
  plus?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <span className="text-small text-fg-3">{kicker}</span>
      <span className="mt-0.5 text-lead font-semibold text-fg">{title}</span>
      <span className="mt-4 block flex-1">{children}</span>
      {plus && (
        <span
          aria-hidden
          className="absolute bottom-3 right-3 grid size-7 place-items-center rounded-full bg-canvas text-fg-2 ring-1 ring-line transition-colors group-hover:text-fg"
        >
          <Plus className="size-4" />
        </span>
      )}
    </>
  );
}

/** The bank's document, as a sheet with its lines and its kind. */
function DocumentPicture() {
  return (
    <span className="relative mx-auto block h-[104px] w-[84px] -rotate-3 rounded-lg bg-canvas p-2.5 shadow-sm ring-1 ring-line">
      <span className={cn(bar, "w-9 bg-fg/20")} />
      <span className={cn(bar, "mt-2.5 w-14")} />
      <span className={cn(bar, "mt-1.5 w-12")} />
      <span className={cn(bar, "mt-1.5 w-14")} />
      <span className={cn(bar, "mt-1.5 w-10")} />
      <span className="absolute -bottom-2 -right-4 rotate-3 rounded-md bg-run px-1.5 py-0.5 text-[10px] font-semibold text-white">
        .docx
      </span>
    </span>
  );
}

/** Rules as people write them, fading out: what a pasted text looks like. */
function TextPicture() {
  return (
    <span className="block text-small leading-relaxed text-fg-4 [mask-image:linear-gradient(to_bottom,black_40%,transparent)]">
      Обращаемся к клиенту на «вы». Пишем коротко и по делу, без канцелярита. Не обещаем того, что не можем сделать.
      Если не знаем ответа, говорим, кто поможет.
    </span>
  );
}

/**
 * «Правила общения» as the step before the criteria, on the page itself: the bank's document, a pasted text, or another
 * agent's rules — a card each, as «Gather your ideas» lays out its kinds of things. A document or a text given shows
 * its name and its text, with «Собрать критерии»; the model collects them, and the criteria come in the step's place
 * (BeforeCheck). Criteria are collected against the conversations, so without a dataset the step says so. Rules saved
 * without criteria (a collection that failed, rules taken before criteria were collected) open as the text given. The
 * text being written survives a reload (lab/tone).
 */
export function AddRules() {
  const { state, refresh } = useLabState();
  const hasSource = !!state?.sources.some((s) => s.id === TONE_ID);
  const source = useSource(hasSource ? TONE_ID : null);
  const [text, setText] = useState(savedText);
  const [name, setName] = useState(savedName);
  const [open, setOpen] = useState(() => !!savedText());
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = useTakeRules(state!, () => void refresh());
  // What the person typed wins over the saved rules; until they type, the step shows the rules.
  const edited = useRef(!!text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!source.data || edited.current) return;
    setText(source.data.content);
    setName(source.data.origin);
    setOpen(true);
  }, [source.data]);
  const change = (value: string) => {
    edited.current = true;
    setText(value);
    rememberText(value);
  };
  const rename = (value: string) => {
    setName(value);
    rememberName(value);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const read = (file?: File) =>
    file &&
    run(async () => {
      if (file.size > 2_000_000) throw new Error("Файл больше 2 МБ. Вставьте правила текстом.");
      const parsed = await upload<{ text: string; name: string }>("/api/tone-of-voice/read-file", file);
      change(parsed.text);
      rename(parsed.name);
      setOpen(true);
    });
  const write = () => {
    setOpen(true);
    setError(null);
    setTimeout(() => area.current?.focus(), 0);
  };
  const back = () => {
    change("");
    rename("Правила общения");
    setOpen(false);
    setError(null);
  };
  const same = !!source.data && source.data.content.trim() === text.trim();
  const dialogues = !!state?.logs.total;
  const waiting = busy || !!state?.job.running;
  const collect = () =>
    run(async () => {
      if (!same) await api("/api/tone-of-voice/policy", { text: text.trim(), name: name.trim() || "Правила общения" });
      await api("/api/tone-of-voice/criteria", {});
      rememberText("");
      edited.current = false;
      await refresh();
    });
  const noDataset = !dialogues && (
    <p className="mt-4 max-w-[62ch] text-body text-fg-2">
      Критерии собираются по разговорам, поэтому сначала нужен датасет.{" "}
      <Link to={SECTIONS.data} className="font-medium text-run hover:underline">
        Добавить датасет
      </Link>
    </p>
  );
  const failed = error && (
    <p role="alert" className="mt-4 text-body text-bad">
      {error}
    </p>
  );

  if (open)
    return (
      <div className="mt-8 max-w-[760px]">
        <div className="rounded-[18px] bg-inset p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-canvas ring-1 ring-line">
              <FileText aria-hidden className="size-4 text-fg-2" />
            </span>
            <label className="min-w-0 flex-1">
              <span className="sr-only">Название правил</span>
              <input
                value={name}
                maxLength={160}
                disabled={waiting}
                onChange={(e) => rename(e.target.value)}
                placeholder="Правила общения"
                className="w-full rounded-sm bg-transparent text-read font-semibold text-fg outline-none placeholder:text-fg-4 focus-visible:ring-2 focus-visible:ring-run/60"
              />
            </label>
            <button
              type="button"
              onClick={back}
              disabled={waiting}
              className="shrink-0 rounded-sm text-small font-medium text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:opacity-40"
            >
              Другой способ
            </button>
          </div>
          <Textarea
            ref={area}
            rows={10}
            value={text}
            maxLength={50000}
            disabled={waiting}
            onChange={(e) => change(e.target.value)}
            placeholder="Вставьте правила общения банка: как обращаться к клиенту, каким тоном писать, чего избегать"
            aria-label="Текст правил"
            className="mt-3 bg-canvas"
          />
          <p className="mt-2 text-small text-fg-3">
            {text.trim().length >= 20
              ? `${count(text.trim().length, "знак", "знака", "знаков")}. Модель соберёт из них критерии, их можно будет поправить.`
              : "Нужно хотя бы несколько предложений правил."}
          </p>
          {noDataset}
          {failed}
          <Button
            className="mt-4"
            variant="primary"
            icon={Sparkles}
            loading={busy}
            disabled={!dialogues || text.trim().length < 20 || !!state?.job.running}
            onClick={collect}
          >
            Собрать критерии
          </Button>
        </div>
      </div>
    );

  return (
    <div className="mt-8">
      <ul className={cn("grid max-w-[920px] gap-3", take.sources.length ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <li>
          <label
            className={cn(PRESS, "cursor-pointer", over && "bg-fg/[0.06] ring-2 ring-run/60")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void read(e.dataTransfer.files[0]);
            }}
          >
            <Way kicker="Загрузите или перетащите" title="Документ банка">
              {busy ? (
                <span className="flex h-[104px] items-center justify-center text-small text-fg-3">
                  <Loader2 aria-hidden className="mr-1.5 size-4 animate-spin" />
                  Читаем документ…
                </span>
              ) : (
                <DocumentPicture />
              )}
              <span className="mt-4 block text-small text-fg-3">.docx, .txt или .md</span>
            </Way>
            <input
              type="file"
              accept=".docx,.txt,.md"
              className="sr-only"
              disabled={waiting}
              onChange={(e) => {
                void read(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </li>
        <li>
          <button type="button" onClick={write} disabled={waiting} className={PRESS}>
            <Way kicker="Вставьте" title="Текст правил">
              <TextPicture />
            </Way>
          </button>
        </li>
        {take.sources.length > 0 && state && (
          <li>
            <div className={CARD}>
              <Way kicker="Скопируйте" title="У другого агента" plus={false}>
                <span className="block space-y-1.5">
                  {take.sources.slice(0, 3).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      disabled={waiting || !!take.busy}
                      onClick={() => take.choose(a)}
                      className="flex w-full items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-left ring-1 ring-line transition-colors hover:ring-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:opacity-60"
                    >
                      {take.busy === a.id ? (
                        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-fg-3" />
                      ) : (
                        <Copy aria-hidden className="size-3.5 shrink-0 text-fg-3" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-fg">{a.name}</span>
                        <span className="block truncate text-small text-fg-3">
                          {a.rules.criteria
                            ? count(a.rules.criteria, "критерий", "критерия", "критериев")
                            : "критерии ещё не собраны"}
                        </span>
                      </span>
                    </button>
                  ))}
                  {take.sources.length > 3 && (
                    <Menu
                      disabled={waiting || !!take.busy}
                      items={take.sources.slice(3).map((a) => ({
                        key: a.id,
                        label: a.name,
                        sub: rulesLine(a.rules),
                        run: () => take.choose(a),
                      }))}
                      trigger={
                        <span className="inline-flex items-center gap-1 px-1 text-small font-medium text-fg-3 hover:text-fg">
                          Ещё {take.sources.length - 3}
                          <ChevronDown aria-hidden className="size-3.5" />
                        </span>
                      }
                    />
                  )}
                </span>
              </Way>
            </div>
            {take.confirm}
          </li>
        )}
      </ul>
      {noDataset}
      {failed}
    </div>
  );
}
