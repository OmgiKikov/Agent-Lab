import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { Button } from "../ui/Button";
import { BASE } from "./agent";
import { SECTIONS } from "./links";
import { Mark } from "./Mark";

/**
 * A screen that failed to draw: a plain message and the way back instead of a white page. The details are for a
 * developer and stay folded (NN/g: say what happened and what to do).
 */
export function ScreenError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-5 py-16">
      <Mark quiet className="size-12 rounded-2xl" />
      <h1 className="mt-6 text-title font-semibold text-fg">Не удалось открыть экран</h1>
      <p className="mt-2 text-read text-fg-2">
        Данные и итоги проверок сохранены. Обновите страницу. Если экран снова не откроется, вернитесь на «Обзор».
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="primary" size="lg" icon={RotateCcw} onClick={() => window.location.reload()}>
          Обновить
        </Button>
        <Button size="lg" onClick={() => window.location.assign(`${BASE}${SECTIONS.overview}`)}>
          К обзору
        </Button>
      </div>
      <details className="mt-8 text-body text-fg-3">
        <summary className="cursor-pointer">Подробности для разработчика</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-small">{detail}</pre>
      </details>
    </main>
  );
}
