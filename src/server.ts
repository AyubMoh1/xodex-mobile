import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./codex/appServerClient.js";
import { CompanionState } from "./codex/state.js";
import { loadConfig } from "./config.js";
import { requireAccessToken } from "./http/auth.js";
import { createApiRouter } from "./http/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export type CreateAppOptions = {
  bridge?: CodexAppServerClient;
  state?: CompanionState;
  config?: ReturnType<typeof loadConfig>;
};

export function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const state = options.state ?? new CompanionState();
  const bridge = options.bridge ?? new CodexAppServerClient(config.codexBin, state);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(projectRoot, "public")));
  app.use("/api", requireAccessToken(config.accessToken), createApiRouter(bridge, state));

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const state = new CompanionState();
  const bridge = new CodexAppServerClient(config.codexBin, state);
  const app = createApp({ bridge, state, config });

  bridge.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to start codex app-server";
    state.setStatus({ codex: "error", message });
  });

  app.listen(config.port, config.host, () => {
    console.log(`xodex-mobile listening on http://${config.host}:${config.port}`);
  });
}
