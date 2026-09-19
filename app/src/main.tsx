import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { watchForUpdates } from "./app/updates";
import { App } from "./ui/App";
import "./ui/styles.css";

watchForUpdates();

const root = document.getElementById("root");
if (root === null) throw new Error("нет узла #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
