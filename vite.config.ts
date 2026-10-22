import { defineConfig } from "vite";

// SITE_URL (e.g. https://example.com) at build time makes the link-preview image URL absolute; X and Facebook need it.
const site = (process.env.SITE_URL ?? "").replace(/\/$/, "");

export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8787" } },
  plugins: [{ name: "site-url", transformIndexHtml: html => html.replaceAll("%SITE_URL%", site) }],
});
