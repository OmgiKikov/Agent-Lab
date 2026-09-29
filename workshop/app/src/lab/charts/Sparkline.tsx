/** A tiny trend line for a headline number: 1.5px line, end dot with a surface ring. */
export function Sparkline({ values, width = 132, height = 40 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const pad = 5;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = Math.max(hi - lo, 10);
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - 2 * pad);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.length - 1;
  return (
    <svg width={width} height={height} role="img" aria-label={`Динамика: ${values.join(", ")}`}>
      <path d={path} fill="none" stroke="rgb(91,141,239)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={3.5} fill="rgb(91,141,239)" stroke="#0a0a0a" strokeWidth={2} />
    </svg>
  );
}
