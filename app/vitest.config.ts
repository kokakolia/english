import { defineConfig } from "vitest/config";

/**
 * Конфигурация тестов отдельно от сборки.
 *
 * Тестам не нужны ни React-плагин, ни генерация service worker: ядро и
 * хранилище работают с чистыми структурами и эмуляцией IndexedDB, подписи
 * экранов проверяются серверным рендерингом React. Своя
 * конфигурация не даёт vitest подхватить сборочную и тащить в прогон лишнее.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
