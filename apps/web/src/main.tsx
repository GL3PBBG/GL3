import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureClient } from "@gl3/client";
import { App } from "./App.js";
import { loadTheme } from "./lib/applyTheme.js";
import { webClientConfig } from "./lib/clientBoot.js";
import "./theme.css";

configureClient(webClientConfig(window));
void loadTheme();

const queryClient = new QueryClient();
const container = document.getElementById("root");
if (!container) throw new Error("#root missing from index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
