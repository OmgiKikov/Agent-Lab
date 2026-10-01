/**
 * The Workshop's colours, light like the rest of the product (design/tokens.css): the same roles as before, from the
 * page to the darkest ink. Hex on purpose: some screens append an alpha to them.
 */
export const C = {
  bg:        "#F8F9FA",
  surface:   "#FFFFFF",
  elevated:  "#F3F4F6",
  border:    "rgba(16,24,32,0.08)",
  borderLight: "rgba(16,24,32,0.14)",

  fg0:       "#868E98",
  fg1:       "#6B7380",
  fg2:       "#565E69",
  fg3:       "#3F4650",
  fg4:       "#23282E",
  fg5:       "#15181C",

  accent:    "#1D5CD6",
  green:     "#187842",
  red:       "#BA261E",
  purple:    "#7C4DDB",
  orange:    "#B76E00",
  cyan:      "#0E7C93",
  user:      "#E5EEFB",

  selected:  "rgba(29,92,214,0.08)",
  selectedBorder: "rgba(29,92,214,0.2)",
} as const;

const SPAN_COLORS = [
  "#2E9E57", "#D98A1F", "#8A63D2", "#1F9AB5",
  "#3F73DA", "#7A8799", "#C9A21E", "#2F9C8F",
  "#6475D9", "#6E9E2E", "#9A7351", "#3E8FD0",
];

export function spanColor(name: string, map: Map<string, string>): string {
  if (!map.has(name)) {
    map.set(name, SPAN_COLORS[map.size % SPAN_COLORS.length]);
  }
  return map.get(name)!;
}
