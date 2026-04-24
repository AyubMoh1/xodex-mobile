import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(projectRoot, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "xodex-mobile" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const app = createApp();

  app.listen(config.port, config.host, () => {
    console.log(`xodex-mobile listening on http://${config.host}:${config.port}`);
  });
}
