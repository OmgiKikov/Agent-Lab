import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Barlow", "system-ui", "sans-serif"],
        mono: ["Space Mono", "monospace"],
      },
      colors: {
        lab: Object.fromEntries(
          ["bg", "surface", "raised", "ink", "text", "soft", "mute", "dim", "faint", "user", "accent", "ok", "bad", "warn"]
            .map(name => [name, `rgb(var(--lab-${name}) / <alpha-value>)`]),
        ),
      },
    },
  },
  plugins: [animate],
};
