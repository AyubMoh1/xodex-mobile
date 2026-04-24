import { existsSync } from "node:fs";

export type AppConfig = {
  port: number;
  host: string;
  codexBin: string;
  accessToken: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8787);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    host: env.HOST || "0.0.0.0",
    codexBin: env.XODEX_CODEX_BIN || defaultCodexBin(),
    accessToken: env.XODEX_ACCESS_TOKEN?.trim() || null,
  };
}

function defaultCodexBin() {
  const macAppBinary = "/Applications/Codex.app/Contents/Resources/codex";
  return existsSync(macAppBinary) ? macAppBinary : "codex";
}
