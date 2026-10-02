import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { reviewLink, type Stage } from "../app/links";
import { count, plural } from "../lab/format";
import type { Problems } from "../lab/problems";
import { verdictsOf } from "../lab/verdicts";

/** Below this many checked conversations a share says little (Hamel Husain: under ~60 an interval is too wide). */
const FEW = 30;

/**
 * How far the number above can be trusted, in plain words under it. What counts is a person's answer on the errors the
 * model found — two models agreeing is not proof they are right (Hamel Husain, «Using LLM-as-a-judge»; Kim et al. 2025).
 * Before any answer it shows the way to give some; with few conversations it says the conclusion is preliminary.
 */
export function Trust({ data, stage, checked }: { data: Problems; stage: Stage; checked: number }) {
  const errors = verdictsOf(data, null, stage).filter((v) => v.example.status === "FAIL");
  const yes = errors.filter((v) => v.example.review === "agree").length;
  const no = errors.filter((v) => v.example.review === "disagree").length;
  const answered = yes + no;
  return (
    <div className="mt-4 space-y-1 text-read text-fg-2">
      {answered > 0 ? (
        <p>
          Вы проверили {count(answered, "найденную ошибку", "найденные ошибки", "найденных ошибок")}: {yes}{" "}
          {plural(yes, "действительно ошибка", "действительно ошибки", "действительно ошибок")}, {no} — нет.{" "}
          {answered < errors.length && (
            <Link to={reviewLink(stage, { queue: "unchecked" })} className="font-medium text-run hover:underline">
              Проверить ещё
            </Link>
          )}
        </p>
      ) : (
        errors.length > 0 && (
          <p>
            Ошибки нашла модель.{" "}
            <Link
              to={reviewLink(stage, { queue: "unchecked" })}
              className="inline-flex items-center gap-1 font-medium text-run hover:underline"
            >
              {errors.length <= 20 ? "Проверьте их" : "Проверьте 10–20 из них"}, чтобы убедиться, что она права
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </p>
        )
      )}
      {checked > 0 && checked < FEW && <p className="text-fg-3">Проверено мало разговоров: вывод предварительный.</p>}
    </div>
  );
}
