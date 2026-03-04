import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config";
import { createApp, type AppInstance } from "../src/app";

interface TestContext {
  tempDir: string;
  app: AppInstance;
}

let context: TestContext;

async function authedRequest(
  app: AppInstance,
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("cookie", cookie);

  return app.fetch(
    new Request(`http://aiktivist.test${path}`, {
      ...init,
      headers,
    }),
  );
}

async function login(app: AppInstance): Promise<string> {
  const response = await app.fetch(
    new Request("http://aiktivist.test/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "password123",
      }),
    }),
  );

  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return String(cookie).split(";")[0];
}

async function createConversation(app: AppInstance, cookie: string): Promise<string> {
  const response = await authedRequest(app, "/api/conversations", cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "test conversation" }),
  });

  expect(response.status).toBe(201);
  const payload = await response.json();
  return payload.conversation.id;
}

async function streamMessage(app: AppInstance, cookie: string, conversationId: string, content: string) {
  const response = await authedRequest(
    app,
    `/api/conversations/${conversationId}/messages`,
    cookie,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  return response.text();
}

beforeEach(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "aiktivist-"));
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dbPath: join(tempDir, "aiktivist.db"),
    eventsJsonlPath: join(tempDir, "events.jsonl"),
    openRouterApiKey: "",
    openRouterBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
    openRouterModel: "google/gemini-3-flash-preview",
    adminUsername: "admin",
    adminPassword: "password123",
    sessionTtlSeconds: 3600,
    allowMockGateway: true,
    appUrl: "http://aiktivist.test",
  };

  const app = await createApp({ config });
  context = { tempDir, app };
});

afterEach(async () => {
  context.app.close();
  await rm(context.tempDir, { recursive: true, force: true });
});

describe("auth and route protection", () => {
  test("protects API routes and allows login", async () => {
    const unauthorized = await context.app.fetch(
      new Request("http://aiktivist.test/api/conversations", {
        method: "GET",
      }),
    );
    expect(unauthorized.status).toBe(401);

    const cookie = await login(context.app);
    const authorized = await authedRequest(context.app, "/api/conversations", cookie, {
      method: "GET",
    });

    expect(authorized.status).toBe(200);
    const payload = await authorized.json();
    expect(Array.isArray(payload.conversations)).toBe(true);
  });
});

describe("conversation routing and persistence", () => {
  test("creates conversations with dedicated URL and persists messages", async () => {
    const cookie = await login(context.app);
    const conversationId = await createConversation(context.app, cookie);

    const pageResponse = await authedRequest(context.app, `/c/${conversationId}`, cookie, {
      method: "GET",
    });
    const html = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(html).toContain("id=\"app\"");

    await streamMessage(context.app, cookie, conversationId, "hello from test");

    const details = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}`,
      cookie,
      {
        method: "GET",
      },
    );

    const payload = await details.json();
    expect(payload.messages.length).toBeGreaterThanOrEqual(2);
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[1].role).toBe("assistant");
    expect(payload.messages[1].content).toContain("Mock OpenRouter stream");
  });

  test("archives, resumes, and deletes conversations", async () => {
    const cookie = await login(context.app);
    const conversationId = await createConversation(context.app, cookie);

    const archived = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}/archive`,
      cookie,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);

    const blocked = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}/messages`,
      cookie,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "should fail" }),
      },
    );
    expect(blocked.status).toBe(409);

    const resumed = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}/resume`,
      cookie,
      { method: "POST" },
    );
    expect(resumed.status).toBe(200);

    const deleted = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}/delete`,
      cookie,
      { method: "POST" },
    );
    expect(deleted.status).toBe(200);

    const afterDelete = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}`,
      cookie,
      { method: "GET" },
    );
    expect(afterDelete.status).toBe(404);
  });
});

describe("streaming and event logging", () => {
  test("streams assistant chunks and logs events", async () => {
    const cookie = await login(context.app);
    const conversationId = await createConversation(context.app, cookie);

    const streamBody = await streamMessage(context.app, cookie, conversationId, "stream this");
    expect(streamBody).toContain("event: start");
    expect(streamBody).toContain("event: delta");
    expect(streamBody).toContain("event: done");

    const eventsResponse = await authedRequest(
      context.app,
      `/api/conversations/${conversationId}/events`,
      cookie,
      { method: "GET" },
    );

    expect(eventsResponse.status).toBe(200);
    const eventsPayload = await eventsResponse.json();
    const eventTypes = eventsPayload.events.map((event: { type: string }) => event.type);

    expect(eventTypes).toContain("gateway.request");
    expect(eventTypes).toContain("gateway.chunk");
    expect(eventTypes).toContain("message.assistant.completed");

    const jsonlRaw = await readFile(join(context.tempDir, "events.jsonl"), "utf8");
    const jsonlTypes = jsonlRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).type);

    expect(jsonlTypes).toContain("gateway.request");
    expect(jsonlTypes).toContain("message.user.created");
    expect(jsonlTypes).toContain("gateway.response");
  });
});
