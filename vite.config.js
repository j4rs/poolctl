import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  test: {
    environment: "jsdom",
    globals: true,
    /* The supervisor lives in the same repo and is plain JS, so its pure
       logic is tested by the same runner. Nothing here reaches `dist`. */
    include: ["src/**/*.test.{js,jsx}", "supervisor/**/*.test.js"],
  },
});
