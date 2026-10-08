import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { count } from "../../lab/format";
import type { Card, Catalog } from "../../lab/types";

/** A business scenario of the tree: its conversations in the export (null without the catalog) and its cards. */
export type ScenarioNode = {
  id: string;
  title: string;
  dialogues: number | null;
  share: number | null;
  cards: Card[];
};
/** A cluster of the catalog (a category): its conversations, its scenarios and how many cards they hold. */
export type ClusterNode = {
  id: string;
  title: string;
  dialogues: number | null;
  share: number | null;
  scenarios: ScenarioNode[];
  cards: number;
};

const NONE = "\u0000none";
const byCount = (a: { dialogues: number | null; title: string }, b: { dialogues: number | null; title: string }) =>
  (b.dialogues ?? 0) - (a.dialogues ?? 0) || a.title.localeCompare(b.title, "ru");

/**
 * The cards as the catalog groups them: clusters, their scenarios, the cards of each, the biggest first. With the
 * catalog every scenario is here, those no card is shown for too, unless only some cards are shown (a filter, a search:
 * whole): then only the scenarios that hold one. Without the catalog the cards' own scenarios make the tree, uncounted.
 */
export function treeOf(cards: Card[], catalog: Catalog | null, whole: boolean): ClusterNode[] {
  const byScenario = new Map<string, Card[]>();
  for (const c of cards) {
    const key = c.scenario?.id ?? NONE;
    byScenario.set(key, [...(byScenario.get(key) ?? []), c]);
  }
  const clusters: ClusterNode[] = [];
  const placed = new Set<string>();
  for (const category of catalog?.categories ?? []) {
    const scenarios = category.scenarios
      .map((s) => ({ id: s.id, title: s.title, dialogues: s.count, share: s.share, cards: byScenario.get(s.id) ?? [] }))
      .filter((s) => whole || s.cards.length);
    scenarios.forEach((s) => placed.add(s.id));
    if (scenarios.length)
      clusters.push({
        id: category.id,
        title: category.title,
        dialogues: category.count,
        share: category.share,
        scenarios: scenarios.sort(byCount),
        cards: scenarios.reduce((n, s) => n + s.cards.length, 0),
      });
  }
  // Cards whose scenario the catalog does not have (no catalog, or another one): grouped by what the card names.
  const rest = new Map<string, ClusterNode>();
  for (const [key, list] of byScenario) {
    if (placed.has(key)) continue;
    const s = list[0].scenario;
    const id = s?.categoryId ?? NONE;
    const cluster = rest.get(id) ?? {
      id,
      title: s?.category ?? "Без сценария каталога",
      dialogues: null,
      share: null,
      scenarios: [],
      cards: 0,
    };
    cluster.scenarios.push({ id: key, title: s?.title ?? "Без сценария", dialogues: null, share: null, cards: list });
    cluster.cards += list.length;
    rest.set(id, cluster);
  }
  const uncounted = [...rest.values()].sort((a, b) => b.cards - a.cards || a.title.localeCompare(b.title, "ru"));
  uncounted.forEach((c) => c.scenarios.sort((a, b) => b.cards.length - a.cards.length));
  return [...clusters.sort(byCount), ...uncounted];
}

const percent = (share: number | null) =>
  share === null ? "" : `${(share * 100).toLocaleString("ru-RU", { maximumFractionDigits: share < 0.1 ? 1 : 0 })}%`;

/** Every conversation is a card: the cards are named apart only where some are missing (the model failed them). */
const short = (dialogues: number | null, cards: number) => dialogues !== null && cards < dialogues;

/** The number of a row: its conversations with their share (its cards without the catalog), and a warning where
 * fewer cards were built than it has conversations. */
function Numbers({ dialogues, share, cards }: { dialogues: number | null; share: number | null; cards: number }) {
  return (
    <span className="w-[88px] flex-shrink-0 text-right text-small tabular-nums text-fg-2">
      {dialogues ?? cards}
      {share !== null && <span className="text-fg-4"> · {percent(share)}</span>}
      {short(dialogues, cards) && (
        <span className="block text-meta text-warn" title="Не для всех разговоров собрана карточка">
          карточек {cards}
        </span>
      )}
    </span>
  );
}

function Branch({
  level,
  open,
  onToggle,
  title,
  children,
  disabled,
}: {
  level: 0 | 1;
  open: boolean;
  onToggle: () => void;
  title: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={disabled ? undefined : open}
      className={cn(
        "flex w-full items-start gap-1.5 rounded-control py-2 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60 enabled:hover:bg-hover",
        level === 0 ? "pl-2" : "pl-7",
      )}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "mt-0.5 size-4 flex-shrink-0 text-fg-3 transition-transform duration-150",
          open && "rotate-90",
          disabled && "invisible",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 text-body",
          level === 0 ? "font-semibold text-fg" : disabled ? "text-fg-3" : "text-fg-2",
        )}
      >
        {title}
      </span>
      {children}
    </button>
  );
}

/**
 * The cards as a tree of the catalog: a cluster opens to its business scenarios, a scenario to the cards of its
 * customers, each row with its conversations in the export and its cards. Which nodes are open is the page's (isOpen,
 * onToggle); a card is drawn by the page (renderCard).
 */
export function ScenarioTree({
  tree,
  isOpen,
  onToggle,
  renderCard,
}: {
  tree: ClusterNode[];
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  renderCard: (card: Card) => ReactNode;
}) {
  return (
    <ul aria-label="Кластеры и сценарии">
      {tree.map((cluster) => {
        const open = isOpen(cluster.id);
        return (
          <li key={cluster.id} className="border-b border-line last:border-b-0">
            <Branch level={0} open={open} onToggle={() => onToggle(cluster.id)} title={cluster.title}>
              <Numbers dialogues={cluster.dialogues} share={cluster.share} cards={cluster.cards} />
            </Branch>
            {open && (
              <ul className="pb-2">
                {cluster.scenarios.map((s) => {
                  const shown = isOpen(s.id) && s.cards.length > 0;
                  return (
                    <li key={s.id}>
                      <Branch
                        level={1}
                        open={shown}
                        onToggle={() => onToggle(s.id)}
                        title={s.title}
                        disabled={!s.cards.length}
                      >
                        <Numbers dialogues={s.dialogues} share={null} cards={s.cards.length} />
                      </Branch>
                      {shown && (
                        <ul className="ml-[2.6rem] border-l border-line pl-1.5">
                          {s.cards.map((c) => (
                            <li key={c.id}>{renderCard(c)}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The column of the tree, over it: what its number is. */
export function TreeHead({ action, counted }: { action?: ReactNode; counted: boolean }) {
  return (
    <div className="flex items-end gap-1.5 border-b border-line px-3 pb-1.5 pl-2 text-meta text-fg-3">
      <span className="min-w-0 flex-1">{action}</span>
      <span className="w-[88px] text-right">{counted ? "Диалогов" : "Карточек"}</span>
    </div>
  );
}

/**
 * The catalog at a glance, while no card is open: each cluster with its conversations and share, its scenarios with
 * theirs and the cards built for them, then what did not get into the catalog. A scenario opens its first card.
 */
export function CatalogTable({
  tree,
  catalog,
  onScenario,
}: {
  tree: ClusterNode[];
  catalog: Catalog | null;
  onScenario: (scenario: ScenarioNode) => void;
}) {
  const scenarios = tree.reduce((n, c) => n + c.scenarios.length, 0);
  const cards = tree.reduce((n, c) => n + c.cards, 0);
  const totals = catalog?.totals;
  const base = totals ? totals.placed : null;
  const missing = base !== null && cards < base;
  return (
    <div className="min-h-0 overflow-auto">
      <div className="max-w-5xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
        <h2 className="text-title font-semibold text-fg">Каталог бизнес-сценариев</h2>
        <p className="mt-2 text-read text-fg-2">
          <span className="font-medium text-fg">
            {count(tree.length, "кластер", "кластера", "кластеров")} и{" "}
            {count(scenarios, "сценарий", "сценария", "сценариев")}
          </span>
          {missing
            ? `, для них ${count(cards, "карточка клиента", "карточки клиентов", "карточек клиентов")}.`
            : ", карточка клиента на каждый разговор."}
          {totals && base !== null
            ? ` Доли считаются от ${count(base, "разговора", "разговоров", "разговоров")} по теме агента из ${totals.dialogues} в выгрузке.`
            : " Каталог, по которому собраны карточки, уже заменён: числа разговоров не показаны."}
        </p>
        <table className="mt-6 w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line-strong text-small text-fg-3">
              <th className="py-2 pr-4 font-medium">Кластер</th>
              <th className="py-2 pr-4 text-right font-medium">{catalog ? "Диалогов" : "Карточек"}</th>
              <th className="py-2 font-medium">Сценарии</th>
            </tr>
          </thead>
          <tbody>
            {tree.map((cluster) => (
              <tr key={cluster.id} className="border-b border-line align-top">
                <td className="w-[200px] py-3 pr-4 text-body font-medium text-fg">{cluster.title}</td>
                <td className="whitespace-nowrap py-3 pr-4 text-right text-body tabular-nums text-fg">
                  {cluster.dialogues ?? cluster.cards}
                  {cluster.share !== null && (
                    <span className="block text-small text-fg-3">{percent(cluster.share)}</span>
                  )}
                  {short(cluster.dialogues, cluster.cards) && (
                    <span className="block text-small text-warn">карточек {cluster.cards}</span>
                  )}
                </td>
                <td className="py-2.5">
                  <ul className="flex flex-wrap gap-1.5">
                    {cluster.scenarios.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          disabled={!s.cards.length}
                          onClick={() => onScenario(s)}
                          title={s.cards.length ? "Открыть первую карточку" : "Карточки для этого сценария нет"}
                          className="inline-flex items-baseline gap-1.5 rounded-control border border-line px-2 py-1 text-left text-small text-fg-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 enabled:hover:border-line-strong enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
                        >
                          {s.title}
                          <span className="whitespace-nowrap tabular-nums text-fg-3">
                            {s.dialogues ?? s.cards.length}
                            {short(s.dialogues, s.cards.length) && (
                              <span className="text-warn"> · карточек {s.cards.length}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {totals && totals.outOfDomain > 0 && (
              <tr className="border-b border-line align-top text-fg-3">
                <td className="py-3 pr-4 text-body">Не про агента</td>
                <td className="py-3 pr-4 text-right text-body tabular-nums">{totals.outOfDomain}</td>
                <td className="py-3 text-small">Разговоры без задачи из домена агента: в каталог не входят.</td>
              </tr>
            )}
            {totals && totals.unplaced + totals.unread > 0 && (
              <tr className="border-b border-line align-top text-fg-3">
                <td className="py-3 pr-4 text-body">Не попали в каталог</td>
                <td className="py-3 pr-4 text-right text-body tabular-nums">{totals.unplaced + totals.unread}</td>
                <td className="py-3 text-small">Модель не прочитала или не разложила их по сценариям.</td>
              </tr>
            )}
            {totals && (
              <tr className="align-top">
                <td className="py-3 pr-4 text-body font-semibold text-fg">Итого</td>
                <td className="py-3 pr-4 text-right text-body font-semibold tabular-nums text-fg">
                  {totals.dialogues}
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
