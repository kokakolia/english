import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { applyTheme, readTheme } from "./app/theme";
import { watchForUpdates } from "./app/updates";

// До первой отрисовки: иначе экран моргнёт светлым и перекрасится.
applyTheme(readTheme());
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
