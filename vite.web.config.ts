import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { SITE_ORIGIN } from "./src/lib/web/links";

// The website build: `npm run build:web` -> dist-web/, a static site that runs in Chrome, Edge and Opera
// over WebHID. Same source as the desktop app; what differs is below.
const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

/** The website's tab icons and the card a shared link shows (public-web/, made by branding/synq/build.py). The
 * desktop app has its window icon and needs none of it. A link preview wants the full address of its picture. */
const webHead = {
  name: "synq-web-head",
  transformIndexHtml: () => [
    { tag: "link", attrs: { rel: "icon", href: "./favicon.svg", type: "image/svg+xml" }, injectTo: "head" as const },
    { tag: "link", attrs: { rel: "icon", href: "./favicon.ico", sizes: "48x48" }, injectTo: "head" as const },
    { tag: "link", attrs: { rel: "apple-touch-icon", href: "./apple-touch-icon.png" }, injectTo: "head" as const },
    { tag: "meta", attrs: { name: "theme-color", content: "#171514" }, injectTo: "head" as const },
    { tag: "meta", attrs: { name: "description", content: "SYNQ: set up your mouse, keyboard, controller and lights right from the browser. Every device. One system." }, injectTo: "head" as const },
    { tag: "meta", attrs: { property: "og:title", content: "SYNQ" }, injectTo: "head" as const },
    { tag: "meta", attrs: { property: "og:description", content: "Every device. One system." }, injectTo: "head" as const },
    { tag: "meta", attrs: { property: "og:image", content: `${SITE_ORIGIN}/og-image.png` }, injectTo: "head" as const },
    { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" }, injectTo: "head" as const },
  ],
};

export default defineConfig({
  plugins: [react(), tailwindcss(), webHead],
  // Relative asset paths, so the folder can be served from a domain root or from a sub-path.
  base: "./",
  // Only the website's `public-web` (headers for static hosts) is copied; the desktop's `public` is not.
  publicDir: "public-web",
  define: {
    // src/lib/runtime.ts: this is the website. Everything under src/lib/web is dead code in the desktop build.
    __ONBOARD_WEB__: "true",
  },
  resolve: {
    alias: [
      // The desktop calls reach the Rust side through these three packages; on the website they land in
      // the browser (guarded WebHID, IndexedDB, window.open).
      { find: "@tauri-apps/api/core", replacement: src("lib/web/tauri-core.ts") },
      { find: "@tauri-apps/api/event", replacement: src("lib/web/tauri-event.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: src("lib/web/tauri-opener.ts") },
      // No Sound page in a browser: the equalizer's code stays out of the bundle.
      { find: "@/components/eq/EqPage", replacement: src("lib/web/stubs/EqPage.tsx") },
      { find: "@", replacement: src("") },
    ],
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
  },
  server: { port: 1421, strictPort: true },
  preview: { port: 4173 },
});
