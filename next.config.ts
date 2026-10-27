import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  output: "standalone",

  // A second dev server beside the usual one (e.g. the demo, DEMO_MODE=true,
  // on its own database) needs its own build directory: two `next dev` in one
  // folder otherwise fight over .next's lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // package.json's version, inlined into client code for the Help menu's bug-report link.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },

  // The formula sandbox reads these library sources off disk at runtime and
  // evaluates them inside the QuickJS isolate (src/lib/grid/runners/sandbox.ts).
  // A readFileSync path is invisible to Next's module tracer, so without this
  // they are missing from the standalone output and every formula fails with
  // "_ is not defined" in production but works in dev.
  outputFileTracingIncludes: {
    "/api/grid/**": [
      "./node_modules/lodash/lodash.min.js",
      "./node_modules/moment/min/moment.min.js",
      "./node_modules/@formulajs/formulajs/lib/browser/formula.min.js",
    ],
  },

  async redirects() {
    // The enrichment grid moved from /grid to /tables, to match what the
    // sidebar has always called it. Existing bookmarks and already-open tabs
    // still point at the old path. Deliberately NOT permanent: a 308 is
    // cached by the browser indefinitely, which would be painful to undo,
    // and there is no SEO to preserve on an authenticated internal tool.
    // Query strings (?folder=, ?table=) are carried over automatically.
    return [
      { source: "/grid", destination: "/tables", permanent: false },
      { source: "/grid/:path*", destination: "/tables/:path*", permanent: false },

      // Settings screens moved into the settings box (src/app/settings).
      // 改造：LinkedIn / WhatsApp / Calling 三个频道已删除，指向它们设置页的
      // 旧跳转一并去掉（目标路由不存在，留着只会 404）。
      { source: "/crm/settings", destination: "/settings/lead-categories", permanent: false },
      { source: "/crm/knowledge", destination: "/settings/knowledge", permanent: false },
      { source: "/outreach/mailboxes", destination: "/settings/email-accounts", permanent: false },
      // Integrations moved into each channel's own Connection page.
      { source: "/settings/integrations", destination: "/settings/email-connection", permanent: false },

      // People and Companies are the two tabs of Leads.
      { source: "/people", destination: "/leads", permanent: false },
      { source: "/companies", destination: "/leads?tab=companies", permanent: false },
    ];
  },
};

export default nextConfig;
