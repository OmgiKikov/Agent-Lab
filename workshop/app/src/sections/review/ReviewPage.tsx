import { useSearchParams } from "react-router-dom";
import { Header } from "../../app/Header";
import { ReviewView } from "../../screens/review/ReviewView";

/** «Проверка вердиктов»: a person goes through the judge's verdicts one by one, V and N, disputed ones first. */
export function ReviewPage() {
  const [params] = useSearchParams();
  const source = params.get("src") === "sim" ? "sim" : "log";
  return (
    <div className="flex h-full flex-col">
      <Header title="Проверка вердиктов" sub={source === "log" ? "логи" : "симуляция"} />
      <div className="min-h-0 flex-1 overflow-hidden"><ReviewView source={source} runId={params.get("run")} /></div>
    </div>
  );
}
