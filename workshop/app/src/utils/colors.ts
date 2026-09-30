/**
 * The Workshop's palette: Raindrop's own, and the same values as the Agent Lab tokens (index.css, docs/DESIGN.md),
 * so the trace viewer and the Lab are one product. Prefer the `lab-*` Tailwind classes in new code;
 * these constants remain for inline styles and SVG.
 */
export const C = {
  bg:        "#000000",
  surface:   "#0a0a0a",
  elevated:  "#111111",
  border:    "rgba(255,255,255,0.06)",
  borderLight: "rgba(255,255,255,0.1)",

  fg0:       "#5a6a72",
  fg1:       "#7d8a90",
  fg2:       "#a0acb2",
  fg3:       "#c8d5dc",
  fg4:       "#e1e8ec",
  fg5:       "#f2f5f7",

  accent:    "#5B8DEF",
  green:     "#60E36D",
  red:       "#F04444",
  purple:    "#A57CF5",
  orange:    "#F0AD4E",
  cyan:      "#4FCAE3",
  user:      "#0D3442",

  selected:  "rgba(91,141,239,0.08)",
  selectedBorder: "rgba(91,141,239,0.2)",
} as const;

/** Categorical hues for span names in the timeline and the span tree only; never the status red. */
const SPAN_COLORS = [
  "#60E36D", "#F0AD4E", "#A57CF5", "#4FCAE3",
  "#5B8DEF", "#94A3B8", "#F5CE4E", "#45B5AA",
  "#7C8CF5", "#8BC34A", "#B08968", "#6DB3F2",
];

export function spanColor(name: string, map: Map<string, string>): string {
  if (!map.has(name)) {
    map.set(name, SPAN_COLORS[map.size % SPAN_COLORS.length]);
  }
  return map.get(name)!;
}
