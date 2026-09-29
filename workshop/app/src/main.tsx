import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { queryClient } from "./query-client";
// Inter and Geist Mono carry Cyrillic (Barlow and Space Mono do not). The full CSS of each package is imported,
// so the browser picks subsets by unicode-range: ₽, № and «» live outside the latin subset.
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/geist-mono/index.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
