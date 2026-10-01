import animate from "tailwindcss-animate";

const rgb = name => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Onest for the interface and reading, JetBrains Mono for labels, counts, paths and code; both carry Cyrillic and ship inside the build.
      fontFamily: {
        sans: ["Onest Variable", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono Variable", "ui-monospace", "monospace"],
      },
      // The named scale (docs/DESIGN.md): reading text is 15; 11 and 12 only for mono labels and hints.
      fontSize: {
        label: ["11px", { lineHeight: "16px" }],
        meta: ["12px", { lineHeight: "16px" }],
        small: ["13px", { lineHeight: "18px" }],
        body: ["14px", { lineHeight: "20px" }],
        read: ["15px", { lineHeight: "24px" }],
        lead: ["16px", { lineHeight: "26px" }],
        count: ["20px", { lineHeight: "24px" }],
        title: ["22px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        // The Workshop's message text (components/ChatFlow, ConvoDetail, pages/SearchPage).
        message: "14px",
      },
      letterSpacing: { caps: "0.06em" },
      borderRadius: { control: "7px", block: "10px", sheet: "14px" },
      boxShadow: { pop: "0 16px 40px -12px rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.08)" },
      transitionTimingFunction: { out: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      colors: {
        canvas: rgb("canvas"),
        side: rgb("side"),
        list: rgb("list"),
        inset: rgb("inset"),
        hover: rgb("hover"),
        raised: rgb("raised"),
        selected: rgb("selected"),
        fg: { DEFAULT: rgb("fg"), 2: rgb("fg-2"), 3: rgb("fg-3"), 4: rgb("fg-4") },
        bad: rgb("bad"),
        ok: rgb("ok"),
        warn: rgb("warn"),
        run: rgb("run"),
        customer: { DEFAULT: rgb("customer"), fg: rgb("customer-fg") },
        line: { DEFAULT: "var(--line)", strong: "var(--line-strong)" },
        well: "var(--well)",
        paper: { DEFAULT: rgb("paper"), well: rgb("paper-well") },
        ink: { DEFAULT: rgb("ink"), 2: rgb("ink-2"), 3: rgb("ink-3"), line: rgb("ink-line"), bad: rgb("ink-bad") },
      },
    },
  },
  plugins: [animate],
};
