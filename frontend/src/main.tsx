// `kumo/styles/standalone` ships pre-compiled Tailwind, which the Kumo
// components depend on for their utility classes. Without this, sidebar,
// surfaces, badges, etc. render as raw HTML. The standalone build also
// ships the kumo-* design tokens we reference from the dashboard layout.
import "@cloudflare/kumo/styles/standalone";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Pin to light mode so the UI matches the Cloudflare dashboard aesthetic.
// Kumo's `data-mode` attribute drives the entire colour palette.
document.documentElement.dataset.mode = "light";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
