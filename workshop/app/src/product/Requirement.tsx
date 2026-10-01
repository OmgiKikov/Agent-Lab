import type { RuleEntry } from "../lab/problems";
import { Label } from "../ui/Label";

/** What the agent must do, as a person reads the criterion: the duty in plain words, when it matters, what is allowed. */
export function Requirement({ r, className }: { r: RuleEntry; className?: string }) {
  const { condition, acceptable } = r.rule;
  return (
    <section aria-label="Что должен делать агент" className={className}>
      <Label>Что должен делать агент</Label>
      <p className="mt-1.5 text-read text-fg">{r.rule.text}</p>
      {(condition || acceptable) && (
        <dl className="mt-3 space-y-1.5 text-small text-fg-2">
          {condition && <div><dt className="inline font-medium text-fg">Когда это важно: </dt><dd className="inline">{condition}</dd></div>}
          {acceptable && <div><dt className="inline font-medium text-fg">Допустимо: </dt><dd className="inline">{acceptable}</dd></div>}
        </dl>
      )}
    </section>
  );
}
