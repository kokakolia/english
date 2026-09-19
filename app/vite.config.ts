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
        // Цвет заставки при запуске. Совпадает с --paper: при несовпадении
        // окно на долю секунды вспыхивает белым, прежде чем показать бумагу.
        background_color: "#f3eedc",
        theme_color: "#f3eedc",
        // Без иконок Chrome не считает приложение устанавливаемым и просто не
        // показывает значок установки, ничего не сообщая. Нужен хотя бы один
        // PNG от 144 пикселей; кладём 192 и 512, как принято.
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            // Отдельный файл с широким полем: систему вправе обрезать иконку
            // до своей формы, и в общей у листа срезало бы кончики.
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
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
