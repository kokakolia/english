import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Английские коллокации",
        short_name: "Коллокации",
        description: "Интервальное повторение английских коллокаций",
        lang: "ru",
        start_url: "/",
        display: "standalone",
        background_color: "#fbfbfa",
        theme_color: "#fbfbfa",
      },
      workbox: {
        // Колода должна попасть в офлайн-кэш вместе с кодом: без неё
        // приложение откроется, но учить будет нечему.
        globPatterns: ["**/*.{js,css,html,json,svg,png,woff2}"],
        // Файл колоды крупнее стандартного порога; без этого он молча
        // выпадет из кэша, и офлайн сломается только у тех, кто ещё не
        // импортировал её в базу.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  // Порт закреплён жёстко, и это не придирка к удобству, а защита прогресса.
  // База IndexedDB привязана к источнику, то есть к паре «схема + порт». Если
  // 5173 занят, vite по умолчанию молча берёт 5174 — приложение откроется, но
  // с пустой базой, как будто месяца занятий не было. `strictPort` превращает
  // эту тихую потерю в честный отказ запуститься.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
