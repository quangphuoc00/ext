import { defineManifest } from "@crxjs/vite-plugin";

const DATA_MATCHES = [
  "https://*.finance.yahoo.com/*",
  "https://optioncharts.io/*",
  "https://finviz.com/*",
  "https://fred.stlouisfed.org/*",
  "https://app.stockoracle.com/*",
];

export default defineManifest({
  manifest_version: 3,
  name: "OptionPilot Scraper",
  version: "0.1.0",
  description: "Scrapes CSP data sources and runs the claude.ai analysis for OptionPilot.",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "OptionPilot",
  },
  options_ui: {
    page: "src/monitor/index.html",
    open_in_tab: true,
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: ["tabs", "windows", "scripting", "alarms", "storage"],
  host_permissions: [
    ...DATA_MATCHES,
    "https://claude.ai/*",
    "https://*.supabase.co/*",
  ],
  content_scripts: [
    {
      matches: DATA_MATCHES,
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://claude.ai/*"],
      js: ["src/content/claude.ts"],
      run_at: "document_idle",
    },
  ],
});
