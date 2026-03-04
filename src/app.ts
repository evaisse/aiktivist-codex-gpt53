import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import {
  clearSessionCookie,
  createSessionCookie,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  readSessionTokenFromRequest,
  verifyPassword,
} from "./auth";
import { ensureParentDirectory, newId, nowIso, openDatabase } from "./db";
import { EventBus } from "./event-bus";
import { EventLog } from "./event-log";
import { appPageHtml, loginPageHtml } from "./html";
import { runMigrations } from "./migrations";
import { OpenRouterGateway, type ChatGateway, type ChatMessage } from "./openrouter";

interface SessionUser {
  id: string;
  username: string;
  sessionId: string;
}

interface ConversationRow {
  id: string;
  userId: string;
  title: string;
  status: "active" | "archived" | "deleted";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}

interface MessageRow {
  id: string;
  conversationId: string;
  userId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status: "streaming" | "done" | "error";
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateAppOptions {
  config?: AppConfig;
  gateway?: ChatGateway;
}

export interface AppInstance {
  config: AppConfig;
  db: Database;
  fetch: (request: Request) => Promise<Response>;
  close: () => void;
}

function sessionCookieSecureFlag(config: AppConfig): boolean {
  return config.appUrl.toLowerCase().startsWith("https://");
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectResponse(url: string, status = 302, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status,
    headers: {
      location: url,
      ...headers,
    },
  });
}

function sseBlock(event: string, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const body: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      body[key] = typeof value === "string" ? value : value.name;
    }
    return body;
  }

  return {};
}

function isPathConversation(pathname: string): string | null {
  const match = pathname.match(/^\/c\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function conversationApiId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function conversationMessagesApiId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function conversationAction(pathname: string): { id: string; action: "archive" | "resume" | "delete" } | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)\/(archive|resume|delete)$/);
  if (!match) {
    return null;
  }
  return {
    id: decodeURIComponent(match[1]),
    action: match[2] as "archive" | "resume" | "delete",
  };
}

function conversationEventsApiId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/conversations\/([^/]+)\/events$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function sanitizeTitle(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "new conversation";
  }
  return trimmed.slice(0, 80);
}

function summarizeMessageAsTitle(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return sanitizeTitle(singleLine.slice(0, 60) || "new conversation");
}

export async function createApp(options: CreateAppOptions = {}): Promise<AppInstance> {
  const config = options.config ?? loadConfig();
  const db = await openDatabase(config.dbPath);

  await runMigrations(db, join(import.meta.dir, "..", "migrations"));

  const eventBus = new EventBus();
  const eventLog = new EventLog(db, config.eventsJsonlPath, eventBus);
  await eventLog.init();

  const gateway = options.gateway ?? new OpenRouterGateway(config);

  const stylesCss = await Bun.file(join(import.meta.dir, "static", "styles.css")).text();
  const appJs = await Bun.file(join(import.meta.dir, "static", "app.js")).text();

  await ensureAdminUser(db, config, eventLog);

  const queries = buildQueries(db);

  async function getSessionUser(request: Request): Promise<SessionUser | null> {
    const token = readSessionTokenFromRequest(request);
    if (!token) {
      return null;
    }

    const tokenHash = await hashSessionToken(token);
    const row = queries.selectSessionUser.get(tokenHash) as
      | {
          sessionId: string;
          userId: string;
          username: string;
          expiresAt: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    if (row.expiresAt <= nowIso()) {
      queries.deleteSessionById.run(row.sessionId);
      return null;
    }

    queries.updateSessionLastSeen.run(nowIso(), row.sessionId);

    return {
      id: row.userId,
      username: row.username,
      sessionId: row.sessionId,
    };
  }

  async function requireUser(request: Request): Promise<SessionUser | Response> {
    const user = await getSessionUser(request);
    if (user) {
      return user;
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const next = encodeURIComponent(`${url.pathname}${url.search}`);
    return redirectResponse(`/login?next=${next}`);
  }

  async function handleLogin(request: Request): Promise<Response> {
    const body = await parseBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) {
      return jsonResponse({ error: "username and password are required" }, 400);
    }

    const user = queries.selectUserByUsername.get(username) as
      | {
          id: string;
          username: string;
          passwordHash: string;
        }
      | undefined;

    if (!user) {
      await eventLog.log({
        type: "auth.login.failed",
        payload: { username, reason: "user_not_found" },
      });
      return jsonResponse({ error: "invalid credentials" }, 401);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await eventLog.log({
        type: "auth.login.failed",
        userId: user.id,
        payload: { username, reason: "bad_password" },
      });
      return jsonResponse({ error: "invalid credentials" }, 401);
    }

    const sessionToken = generateSessionToken();
    const sessionTokenHash = await hashSessionToken(sessionToken);
    const sessionId = newId("sess");
    const now = nowIso();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();

    queries.insertSession.run(
      sessionId,
      user.id,
      sessionTokenHash,
      request.headers.get("x-forwarded-for") || null,
      request.headers.get("user-agent") || null,
      now,
      now,
      expiresAt,
    );

    await eventLog.log({
      type: "auth.login.success",
      userId: user.id,
      payload: { sessionId },
    });

    return jsonResponse(
      {
        ok: true,
        user: {
          id: user.id,
          username: user.username,
        },
      },
      200,
      {
        "set-cookie": createSessionCookie(
          sessionToken,
          config.sessionTtlSeconds,
          sessionCookieSecureFlag(config),
        ),
      },
    );
  }

  async function handleLogout(request: Request, user: SessionUser): Promise<Response> {
    const token = readSessionTokenFromRequest(request);
    if (token) {
      const tokenHash = await hashSessionToken(token);
      queries.deleteSessionByTokenHash.run(tokenHash);
    }

    await eventLog.log({
      type: "auth.logout",
      userId: user.id,
      payload: { sessionId: user.sessionId },
    });

    return jsonResponse({ ok: true }, 200, {
      "set-cookie": clearSessionCookie(sessionCookieSecureFlag(config)),
    });
  }

  async function listConversations(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = queries.listConversations.all(userId) as Array<{
      id: string;
      title: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      lastMessage: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastMessage: row.lastMessage,
    }));
  }

  function getConversationForUser(userId: string, conversationId: string): ConversationRow | null {
    const row = queries.getConversationForUser.get(conversationId, userId) as
      | ConversationRow
      | undefined;
    return row ?? null;
  }

  async function createConversation(user: SessionUser, customTitle?: string): Promise<ConversationRow> {
    const now = nowIso();
    const id = newId("conv");
    const title = sanitizeTitle(customTitle || "new conversation");

    queries.insertConversation.run(id, user.id, title, "active", now, now, null, null);

    await eventLog.log({
      type: "conversation.created",
      userId: user.id,
      conversationId: id,
      payload: { title },
    });

    return {
      id,
      userId: user.id,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    };
  }

  async function updateConversationStatus(
    user: SessionUser,
    conversationId: string,
    action: "archive" | "resume" | "delete",
  ): Promise<Response> {
    const conversation = getConversationForUser(user.id, conversationId);
    if (!conversation || conversation.status === "deleted") {
      return jsonResponse({ error: "conversation not found" }, 404);
    }

    const now = nowIso();
    if (action === "archive") {
      queries.updateConversationArchive.run("archived", now, now, conversationId, user.id);
    }
    if (action === "resume") {
      queries.updateConversationResume.run("active", now, conversationId, user.id);
    }
    if (action === "delete") {
      queries.updateConversationDelete.run("deleted", now, now, conversationId, user.id);
    }

    await eventLog.log({
      type: `conversation.${action}d`,
      userId: user.id,
      conversationId,
      payload: {},
    });

    const updated = getConversationForUser(user.id, conversationId);
    return jsonResponse({ ok: true, conversation: updated });
  }

  function getMessages(conversationId: string): MessageRow[] {
    return queries.listMessagesByConversation.all(conversationId) as MessageRow[];
  }

  async function streamAssistantResponse(
    user: SessionUser,
    conversation: ConversationRow,
    userPrompt: string,
  ): Promise<Response> {
    const now = nowIso();

    const userMessageId = newId("msg");
    queries.insertMessage.run(
      userMessageId,
      conversation.id,
      user.id,
      "user",
      userPrompt,
      "done",
      JSON.stringify({ source: "client" }),
      now,
      now,
    );

    const titleNeeded = conversation.title === "new conversation";
    if (titleNeeded) {
      const generatedTitle = summarizeMessageAsTitle(userPrompt);
      queries.updateConversationTitle.run(generatedTitle, nowIso(), conversation.id, user.id);
    } else {
      queries.touchConversation.run(nowIso(), conversation.id, user.id);
    }

    await eventLog.log({
      type: "message.user.created",
      userId: user.id,
      conversationId: conversation.id,
      payload: {
        messageId: userMessageId,
        content: userPrompt,
      },
    });

    const previousMessages = getMessages(conversation.id)
      .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
      .map((message) => ({ role: message.role, content: message.content })) as ChatMessage[];

    const assistantMessageId = newId("msg");
    queries.insertMessage.run(
      assistantMessageId,
      conversation.id,
      null,
      "assistant",
      "",
      "streaming",
      JSON.stringify({ provider: "openrouter" }),
      nowIso(),
      nowIso(),
    );

    await eventLog.log({
      type: "gateway.request",
      userId: user.id,
      conversationId: conversation.id,
      payload: {
        provider: "openrouter",
        model: config.openRouterModel,
        endpoint: config.openRouterBaseUrl,
        messages: previousMessages,
      },
    });

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (eventName: string, payload: unknown) => {
          controller.enqueue(sseBlock(eventName, payload));
        };

        const fail = async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          queries.updateMessageContentAndStatus.run(
            `[error] ${message}`,
            "error",
            nowIso(),
            assistantMessageId,
          );
          await eventLog.log({
            type: "gateway.error",
            userId: user.id,
            conversationId: conversation.id,
            payload: {
              assistantMessageId,
              message,
            },
          });
          send("error", { message });
          send("done", { ok: false, assistantMessageId });
          controller.close();
        };

        (async () => {
          let accumulated = "";
          let chunkCount = 0;
          send("start", {
            assistantMessageId,
            userMessageId,
            conversationId: conversation.id,
          });

          for await (const event of gateway.stream({ messages: previousMessages })) {
            if (event.kind === "delta") {
              chunkCount += 1;
              accumulated += event.text;
              queries.updateMessageContentStreaming.run(accumulated, nowIso(), assistantMessageId);

              await eventLog.log({
                type: "gateway.chunk",
                userId: user.id,
                conversationId: conversation.id,
                payload: {
                  assistantMessageId,
                  delta: event.text,
                  raw: event.raw,
                  index: chunkCount,
                },
              });

              await eventLog.log({
                type: "message.assistant.delta",
                userId: user.id,
                conversationId: conversation.id,
                payload: {
                  messageId: assistantMessageId,
                  delta: event.text,
                  index: chunkCount,
                },
              });

              send("delta", {
                assistantMessageId,
                delta: event.text,
              });
            }

            if (event.kind === "done") {
              queries.updateMessageContentAndStatus.run(accumulated, "done", nowIso(), assistantMessageId);
              queries.touchConversation.run(nowIso(), conversation.id, user.id);

              await eventLog.log({
                type: "gateway.response",
                userId: user.id,
                conversationId: conversation.id,
                payload: {
                  assistantMessageId,
                  chunks: chunkCount,
                  chars: accumulated.length,
                  raw: event.raw,
                },
              });

              await eventLog.log({
                type: "message.assistant.completed",
                userId: user.id,
                conversationId: conversation.id,
                payload: {
                  messageId: assistantMessageId,
                },
              });

              send("done", {
                ok: true,
                assistantMessageId,
              });
              controller.close();
              return;
            }
          }

          queries.updateMessageContentAndStatus.run(accumulated, "done", nowIso(), assistantMessageId);
          queries.touchConversation.run(nowIso(), conversation.id, user.id);
          send("done", {
            ok: true,
            assistantMessageId,
          });
          controller.close();
        })().catch((error) => {
          fail(error).catch(() => {
            send("error", { message: "internal_error" });
            send("done", { ok: false, assistantMessageId });
            controller.close();
          });
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/assets/styles.css") {
      return new Response(stylesCss, {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/assets/app.js") {
      return new Response(appJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (request.method === "GET" && pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (request.method === "GET" && pathname === "/login") {
      const user = await getSessionUser(request);
      if (user) {
        return redirectResponse("/");
      }
      return htmlResponse(loginPageHtml());
    }

    if (request.method === "POST" && pathname === "/api/login") {
      return handleLogin(request);
    }

    const requiredUser = await requireUser(request);
    if (requiredUser instanceof Response) {
      return requiredUser;
    }

    const user = requiredUser;

    if (request.method === "POST" && pathname === "/api/logout") {
      return handleLogout(request, user);
    }

    if (request.method === "GET" && pathname === "/") {
      return htmlResponse(appPageHtml(user.username));
    }

    if (request.method === "GET" && isPathConversation(pathname)) {
      return htmlResponse(appPageHtml(user.username));
    }

    if (request.method === "GET" && pathname === "/api/me") {
      return jsonResponse({
        user: {
          id: user.id,
          username: user.username,
        },
      });
    }

    if (request.method === "GET" && pathname === "/api/conversations") {
      return jsonResponse({
        conversations: await listConversations(user.id),
      });
    }

    if (request.method === "POST" && pathname === "/api/conversations") {
      const body = await parseBody(request);
      const title = typeof body.title === "string" ? body.title : undefined;
      const conversation = await createConversation(user, title);
      return jsonResponse({ conversation }, 201);
    }

    const conversationId = conversationApiId(pathname);
    if (request.method === "GET" && conversationId) {
      const conversation = getConversationForUser(user.id, conversationId);
      if (!conversation || conversation.status === "deleted") {
        return jsonResponse({ error: "conversation not found" }, 404);
      }
      const messages = getMessages(conversation.id).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        metadata: JSON.parse(message.metadataJson),
      }));

      return jsonResponse({ conversation, messages });
    }

    const actionMatch = conversationAction(pathname);
    if (request.method === "POST" && actionMatch) {
      return updateConversationStatus(user, actionMatch.id, actionMatch.action);
    }

    const eventsConversationId = conversationEventsApiId(pathname);
    if (request.method === "GET" && eventsConversationId) {
      const conversation = getConversationForUser(user.id, eventsConversationId);
      if (!conversation || conversation.status === "deleted") {
        return jsonResponse({ error: "conversation not found" }, 404);
      }

      return jsonResponse({
        events: eventLog.listForConversation(eventsConversationId, 200),
      });
    }

    if (request.method === "GET" && pathname === "/api/events/stream") {
      const conversationFilter = url.searchParams.get("conversationId");
      const stream = eventBus.createStream(user.id, conversationFilter || null);
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }

    const messageConversationId = conversationMessagesApiId(pathname);
    if (request.method === "POST" && messageConversationId) {
      const conversation = getConversationForUser(user.id, messageConversationId);
      if (!conversation || conversation.status === "deleted") {
        return jsonResponse({ error: "conversation not found" }, 404);
      }
      if (conversation.status === "archived") {
        return jsonResponse({ error: "conversation is archived" }, 409);
      }

      const body = await parseBody(request);
      const content = String(body.content || "").trim();
      if (!content) {
        return jsonResponse({ error: "content is required" }, 400);
      }

      return streamAssistantResponse(user, conversation, content);
    }

    return jsonResponse({ error: "not found" }, 404);
  };

  return {
    config,
    db,
    fetch: fetchHandler,
    close: () => {
      eventBus.close();
      db.close(false);
    },
  };
}

function buildQueries(db: Database) {
  return {
    selectUserByUsername: db.query(
      "SELECT id, username, password_hash as passwordHash FROM users WHERE username = ?",
    ),
    insertUser: db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ),
    selectSessionUser: db.query(
      "SELECT s.id as sessionId, s.user_id as userId, s.expires_at as expiresAt, u.username as username FROM sessions s INNER JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    ),
    insertSession: db.query(
      "INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateSessionLastSeen: db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?"),
    deleteSessionById: db.query("DELETE FROM sessions WHERE id = ?"),
    deleteSessionByTokenHash: db.query("DELETE FROM sessions WHERE token_hash = ?"),

    listConversations: db.query(
      "SELECT c.id, c.title, c.status, c.created_at as createdAt, c.updated_at as updatedAt, (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as lastMessage FROM conversations c WHERE c.user_id = ? AND c.status != 'deleted' ORDER BY c.updated_at DESC",
    ),
    getConversationForUser: db.query(
      "SELECT id, user_id as userId, title, status, created_at as createdAt, updated_at as updatedAt, archived_at as archivedAt, deleted_at as deletedAt FROM conversations WHERE id = ? AND user_id = ?",
    ),
    insertConversation: db.query(
      "INSERT INTO conversations (id, user_id, title, status, created_at, updated_at, archived_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    touchConversation: db.query(
      "UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?",
    ),
    updateConversationTitle: db.query(
      "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ),
    updateConversationArchive: db.query(
      "UPDATE conversations SET status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ),
    updateConversationResume: db.query(
      "UPDATE conversations SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?",
    ),
    updateConversationDelete: db.query(
      "UPDATE conversations SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ),

    listMessagesByConversation: db.query(
      "SELECT id, conversation_id as conversationId, user_id as userId, role, content, status, metadata_json as metadataJson, created_at as createdAt, updated_at as updatedAt FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
    ),
    insertMessage: db.query(
      "INSERT INTO messages (id, conversation_id, user_id, role, content, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateMessageContentStreaming: db.query(
      "UPDATE messages SET content = ?, status = 'streaming', updated_at = ? WHERE id = ?",
    ),
    updateMessageContentAndStatus: db.query(
      "UPDATE messages SET content = ?, status = ?, updated_at = ? WHERE id = ?",
    ),
  };
}

async function ensureAdminUser(db: Database, config: AppConfig, eventLog: EventLog): Promise<void> {
  const query = db.query("SELECT id FROM users WHERE username = ?");
  const existing = query.get(config.adminUsername) as { id: string } | undefined;

  if (existing) {
    return;
  }

  const now = nowIso();
  const userId = newId("usr");
  const passwordHash = await hashPassword(config.adminPassword);
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, config.adminUsername, passwordHash, now, now);

  await eventLog.log({
    type: "auth.admin.bootstrap",
    userId,
    payload: { username: config.adminUsername },
  });
}
