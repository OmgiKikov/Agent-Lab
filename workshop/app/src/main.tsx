import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { queryClient } from "./query-client";
// Raindrop's faces are Barlow and Space Mono, neither has Cyrillic: Commissioner is the grotesk closest to Barlow that has it,
// Geist Mono is what Raindrop itself uses for labels and ids. The full CSS of each package is imported,
// so the browser picks subsets by unicode-range: ₽, № and «» live outside the latin subset.
import "@fontsource-variable/commissioner/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
