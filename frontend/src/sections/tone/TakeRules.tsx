import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Loader2 } from "lucide-react";
import { rulesLine, takeRules, useRulesSources, type RulesSource } from "../../lab/agents";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { TONE_ID, toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";

/**
 * What taking another agent's rules takes away from this one, said before it happens: its rules and criteria with
 * their clarifications, its result — out of the section when the rules differ, kept for the previous criteria when they
 * are the same — and the scenarios built from tone of voice (backend: tone.take).
 */
function whatGoes(state: LabState, from: RulesSource) {
  const own = state.sources.find((s) => s.id === TONE_ID);
  const same = !!own?.sha256 && own.sha256 === from.rules.sha256;
  const deck = state.cards?.check === "tone" && !!state.cards.cards.length;
  return [
    `Правила и критерии заменятся правилами агента «${from.name}».`,
    toneResult(state) &&
      (same
        ? "Итог tone of voice останется, но будет относиться к предыдущей версии критериев."
        : "Итог tone of voice уйдёт в историю."),
    deck && "Сценарии, собранные из tone of voice, сбросятся.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * «Взять у другого агента»: in a bank the rules of communication are usually common to all support agents. Another
 * agent's rules and their criteria, with the clarifications people confirmed, become this agent's own as a copy;
 * after that each agent keeps its own. Shown only when another agent has rules. Rules or a result this agent has are
 * replaced only after the person agrees. `onTaken` gets whether criteria are ready to check.
 */
export function TakeRules({
  state,
  disabled,
  onTaken,
}: {
  state: LabState;
  disabled: boolean;
  onTaken: (criteria: boolean) => void;
}) {
  const sources = useRulesSources();
  const { refresh } = useLabState();
  const client = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState<RulesSource | null>(null);
  const [busy, setBusy] = useState(false);
  if (!sources.length) return null;
  const take = async (from: RulesSource) => {
    setAsked(null);
    setBusy(true);
    try {
      const { unchanged } = await takeRules(from.id);
      await refresh();
      void client.invalidateQueries({ queryKey: ["agents"] });
      const criteria = from.rules.criteria;
      toast.notify(
        unchanged
          ? `Правила и критерии уже те же, что у агента «${from.name}»`
          : criteria
            ? `Правила общения и ${count(criteria, "критерий", "критерия", "критериев")} взяты у агента «${from.name}»`
            : `Правила общения взяты у агента «${from.name}»: соберите по ним критерии`,
      );
      onTaken(unchanged ? !!state.toneOfVoice : criteria > 0);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  // Rules or a result of this agent are replaced only after the person agrees; an agent without them just takes.
  const choose = (from: RulesSource) =>
    state.sources.some((s) => s.id === TONE_ID) || toneResult(state) ? setAsked(from) : void take(from);
  return (
    <>
      <Menu
        disabled={disabled || busy}
        items={sources.map((a) => ({ key: a.id, label: a.name, sub: rulesLine(a.rules), run: () => choose(a) }))}
        trigger={
          <span className={buttonClass({ variant: "ghost" })}>
            {busy ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Copy aria-hidden className="size-3.5" />
            )}
            Взять у другого агента
            <ChevronDown aria-hidden className="size-3.5" />
          </span>
        }
      />
      <Modal
        open={!!asked}
        onClose={() => setAsked(null)}
        title={asked ? `Взять правила агента «${asked.name}»?` : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsked(null)}>
              Отмена
            </Button>
            <Button variant="primary" onClick={() => asked && void take(asked)}>
              Взять правила
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">{asked && whatGoes(state, asked)}</p>
        <p className="mt-3 text-body text-fg-3">Это копия: дальше у каждого агента свои правила и критерии.</p>
      </Modal>
    </>
  );
}
