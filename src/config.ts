export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  eventsJsonlPath: string;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  adminUsername: string;
  adminPassword: string;
  sessionTtlSeconds: number;
  allowMockGateway: boolean;
  appUrl: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const host = env.HOST || "0.0.0.0";
  const port = parseNumber(env.PORT, 3000);
  const dbPath = env.DB_PATH || "./data/aiktivist.db";
  const eventsJsonlPath = env.EVENTS_JSONL_PATH || "./data/events.jsonl";

  return {
    host,
    port,
    dbPath,
    eventsJsonlPath,
    openRouterApiKey: env.OPENROUTER_API_KEY || "",
    openRouterBaseUrl:
      env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1/chat/completions",
    openRouterModel: env.OPENROUTER_MODEL || "google/gemini-3-flash-preview",
    adminUsername: env.ADMIN_USERNAME || "admin",
    adminPassword: env.ADMIN_PASSWORD || "change-me-now",
    sessionTtlSeconds: parseNumber(env.SESSION_TTL_SECONDS, 7 * 24 * 60 * 60),
    allowMockGateway: parseBoolean(env.OPENROUTER_ALLOW_MOCK, true),
    appUrl: env.APP_URL || `http://${host}:${port}`,
  };
}
