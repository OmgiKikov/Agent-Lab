import { count } from "../lab/format";
import type { KnowledgePassage } from "../lab/types";

/** The passages the judge actually received, or the explicit reason they were unavailable. */
export function KnowledgeEvidence({
  articles,
  error,
}: {
  articles?: KnowledgePassage[] | null;
  error?: string | null;
}) {
  if (!articles?.length && !error) return null;
  return (
    <section className="mt-5 rounded-block border border-line p-4">
      {error && (
        <p role="status" className="text-body text-warn">
          {error}
        </p>
      )}
      {!!articles?.length && (
        <details>
          <summary className="cursor-pointer text-body font-medium text-fg">
            Источники базы знаний · {count(articles.length, "фрагмент", "фрагмента", "фрагментов")}
          </summary>
          <div className="mt-4 space-y-4">
            {articles.map((a, i) => (
              <div key={`${a.article}-${i}`}>
                <h4 className="text-body font-medium text-fg">{a.title}</h4>
                <p className="mt-1 whitespace-pre-wrap text-small text-fg-3">{a.text}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
