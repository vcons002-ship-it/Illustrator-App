// The app's stylesheet — tokens, base, motion, components, layout. Imported HERE and only
// here: packages/ui ships raw TypeScript with no vite/client types, so a component-level
// `import "./x.css"` would fail typecheck. One import at the entry gives every component
// (including portalled ones, since the tokens are declared on :root) the whole system.
import "@visual-reader/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
