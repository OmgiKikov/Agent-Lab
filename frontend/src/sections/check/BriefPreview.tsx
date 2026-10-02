import { Link } from "react-router-dom";
import { shareBase } from "../../app/agent";

/** Present the generated meeting brief as a document; copied and downloaded text stays Markdown. */
export function BriefPreview({ text }: { text: string }) {
  return (
    <article className="space-y-5 rounded-block bg-paper p-5 text-read text-ink sm:p-8">
      {text.split("\n\n").map((block, index) => {
        if (block.startsWith("# "))
          return (
            <h2 key={index} className="text-title font-semibold">
              {block.slice(2)}
            </h2>
          );
        if (block.startsWith("## "))
          return (
            <h3 key={index} className="border-t border-ink-line pt-6 text-lead font-semibold">
              {block.slice(3)}
            </h3>
          );
        return (
          <div key={index} className="space-y-2 break-words text-ink-2">
            {block.split("\n").map((line, n) => {
              if (line.startsWith("> "))
                return (
                  <blockquote key={n} className="border-l-2 border-mark-strong pl-3 text-ink">
                    {line.slice(2)}
                  </blockquote>
                );
              const link = /^\[([^\]]+)\]\((https?:\/\/[^\s]+)\)\.$/.exec(line);
              if (link && link[2].startsWith(shareBase() + "/start?history="))
                return (
                  <Link
                    key={n}
                    to={link[2].slice(shareBase().length)}
                    className="inline-flex min-h-11 items-center font-medium text-run underline"
                  >
                    {link[1]}
                  </Link>
                );
              return <p key={n}>{line}</p>;
            })}
          </div>
        );
      })}
    </article>
  );
}
