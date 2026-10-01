import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Label } from "../ui/Label";

export type Fact = { label: string; value: ReactNode; to?: string; title?: string };

/** A row of facts: mono capitals over each value; a fact with an address opens what it is made of. */
export function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-3.5 sm:flex sm:flex-wrap sm:gap-x-9">
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt>
            <Label>{f.label}</Label>
          </dt>
          <dd className="mt-1 text-read text-fg">
            {f.to ? (
              <Link
                to={f.to}
                title={f.title}
                className="rounded-sm decoration-line-strong underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
              >
                {f.value}
              </Link>
            ) : (
              <span title={f.title}>{f.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
