/** Russian plural: 1 сценарий, 2 сценария, 5 сценариев. */
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** «5 сценариев» */
/** «300 разговоров» — the number never parts from its word at a line break. */
export const count = (n: number, one: string, few: string, many: string) => `${n}\u00a0${plural(n, one, few, many)}`;

/** A whole percent that never contradicts the count beside it: 1 of 300 is 1%, not 0%; 299 of 300 is 99%, not 100%. */
export const pct = (a: number, b: number) => {
  if (!b) return 0;
  const share = Math.round((100 * a) / b);
  return a > 0 && a < b ? Math.min(99, Math.max(1, share)) : share;
};

export const when = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

export const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "";

export const thousands = (chars: number) => `${(Math.round(chars / 100) / 10).toLocaleString("ru-RU")} тыс. знаков`;

/** «08:40»: the time of day alone. */
export const time = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";

/** «28 сентября»: a date as people say it, for sentences. */
export const longDay = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
