import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { applyTheme, readTheme } from "./app/theme";
import { watchForUpdates } from "./app/updates";

// До первой отрисовки: иначе экран моргнёт светлым и перекрасится.
applyTheme(readTheme());
import { App } from "./ui/App";
import { InstanceGate } from "./ui/InstanceGate";
import "./ui/styles.css";

watchForUpdates();

// Повторный запуск установленного PWA возвращает пользователя в текущее занятие.
const launcher = window as Window & { launchQueue?: { setConsumer(callback: () => void): void } };
launcher.launchQueue?.setConsumer(() => {
  window.focus();
  window.dispatchEvent(new Event("collocations:resume"));
});

const root = document.getElementById("root");
if (root === null) throw new Error("нет узла #root");

createRoot(root).render(
  <InstanceGate>
    <StrictMode><App /></StrictMode>
  </InstanceGate>,
);
