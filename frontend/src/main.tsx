import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { AGENT, BASE, rememberAgent } from "./app/agent";
import { homeRouter } from "./home";
import { productRouter } from "./router";
import { queryClient } from "./query-client";
import "@fontsource-variable/onest";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

// Inside an agent (/a/<id>/…) the product; anywhere else the list of agents or the way into one.
if (AGENT) rememberAgent(AGENT);

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={AGENT ? productRouter(BASE) : homeRouter} />
  </QueryClientProvider>,
);
