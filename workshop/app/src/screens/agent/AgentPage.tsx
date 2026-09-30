import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { JobStrip } from "../../shell/Activity";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Tabs } from "../../ui/Tabs";
import { useToast } from "../../ui/toast";
import { Code } from "./Code";
import { Criteria, Reextract } from "./Criteria";
import { Connection } from "./Connection";

type Tab = "connection" | "code" | "criteria";

/** Агент: who is being checked — how to reach it, and what the product read from its code. */
export function AgentPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const [reextract, setReextract] = useState(false);
  const wanted = params.get("tab");
  const tab: Tab = wanted === "code" || wanted === "criteria" ? wanted : "connection";
  const set = (edit: (n: URLSearchParams) => void) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace: true });
  const setTab = (t: Tab) => set(n => { n.delete("source"); n.delete("c"); if (t === "connection") n.delete("tab"); else n.set("tab", t); });
  const openSource = (id: string | null) => set(n => { if (id) n.set("source", id); else n.delete("source"); });
  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  const read = () => api("/api/sources", {}).then(() => refresh()).catch(toast.error);
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Агент" }]}
        actions={tab === "criteria" ? (
          <Button icon={RotateCcw} onClick={() => setReextract(true)} disabled={busy || !state?.discover} title={busy ? "Сейчас идёт другая задача" : undefined}>Извлечь заново</Button>
        ) : tab === "code" && (
          <Button
            variant="primary" icon={BookOpen} onClick={read} disabled={busy || !state?.settings.repo}
            title={busy ? "Сейчас идёт другая задача" : !state?.settings.repo ? "Сначала укажите папку с кодом во вкладке «Подключение»" : "Прочитать промпты и инструменты агента и выделить из них критерии"}
          >
            Прочитать код
          </Button>
        )}
        below={<JobStrip kinds={["sources"]} />}
      />
      <Tabs<Tab> className="px-4" value={tab} onChange={setTab} tabs={[
        { value: "connection", label: "Подключение" },
        { value: "code", label: "Код", count: state?.sources.length },
        { value: "criteria", label: "Критерии", count: state?.sources.reduce((n, x) => n + x.rules, 0) },
      ]} />
      <div className="min-h-0 flex-1 overflow-auto">
        {!state ? <div className="p-6"><Skeleton className="h-64" /></div>
          : tab === "criteria" ? <Criteria />
          : tab === "code" ? <Code state={state} openId={params.get("source")} onOpen={openSource} />
          : <Connection state={state} />}
      </div>
      <Reextract open={reextract} onClose={() => setReextract(false)} />
    </div>
  );
}
