/**
 * The Workshop's palette, on the same tokens as Agent Lab (index.css, docs/DESIGN.md), so the trace viewer and the Lab are one product.
 * Prefer the `lab-*` Tailwind classes in new code; these constants remain for inline styles and SVG.
 */
export const C = {
  bg:        "#0a0b0d",
  surface:   "#0f1012",
  elevated:  "#141519",
  border:    "rgba(255,255,255,0.06)",
  borderLight: "rgba(255,255,255,0.1)",

  fg0:       "#5f646d",
  fg1:       "#8d929c",
  fg2:       "#a7acb5",
  fg3:       "#c5c9d0",
  fg4:       "#dcdfe4",
  fg5:       "#f2f3f5",

  accent:    "#7b8bff",
  green:     "#5dd39e",
  red:       "#ec5b62",
  purple:    "#a78bfa",
  orange:    "#e6ac45",
  cyan:      "#67c7da",
  user:      "#1e2432",

  selected:  "rgba(123,139,255,0.08)",
  selectedBorder: "rgba(123,139,255,0.22)",
} as const;

/** Categorical hues for span names in the timeline: calm, similar lightness, none of them the status red. */
const SPAN_COLORS = [
  "#7b8bff", "#5fb8a8", "#c9a15a", "#a78bfa",
  "#6aa7d8", "#9aa3b2", "#b88a6a", "#7fb77e",
  "#d08bb0", "#8fa0c8", "#c7b56b", "#6fc2c9",
];

export function spanColor(name: string, map: Map<string, string>): string {
  if (!map.has(name)) {
    map.set(name, SPAN_COLORS[map.size % SPAN_COLORS.length]);
  }
  return map.get(name)!;
}
