const state = {
  username: document.getElementById("app")?.dataset.username || "",
  conversations: [],
  currentConversationId: null,
  messages: [],
  streamInFlight: false,
  eventSource: null,
};

const elements = {
  conversationList: document.getElementById("conversation-list"),
  conversationPath: document.getElementById("conversation-path"),
  messages: document.getElementById("messages"),
  logs: document.getElementById("logs"),
  status: document.getElementById("status-line"),
  composer: document.getElementById("composer"),
  input: document.getElementById("message-input"),
  newConversation: document.getElementById("new-conversation"),
  archiveConversation: document.getElementById("archive-conversation"),
  resumeConversation: document.getElementById("resume-conversation"),
  deleteConversation: document.getElementById("delete-conversation"),
  logout: document.getElementById("logout"),
};

function setStatus(text, tone = "muted") {
  elements.status.textContent = text;
  elements.status.dataset.tone = tone;
}

function appendLog(entry) {
  const timestamp = new Date(entry.createdAt || Date.now()).toLocaleTimeString();
  const line = `[${timestamp}] ${entry.type} ${JSON.stringify(entry.payload || {})}`;
  const previous = elements.logs.textContent ? elements.logs.textContent.split("\n") : [];
  previous.push(line);
  elements.logs.textContent = previous.slice(-250).join("\n");
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // ignored
    }
    throw new Error(message);
  }

  return response.json();
}

function renderConversationList() {
  const items = state.conversations
    .map((conversation) => {
      const activeClass = conversation.id === state.currentConversationId ? "is-active" : "";
      const statusLabel = conversation.status === "archived" ? " [archived]" : "";
      return `
<li class="conversation-item ${activeClass}" data-id="${conversation.id}">
  <button class="conversation-select" type="button">${escapeHtml(conversation.title)}${statusLabel}</button>
  <span class="conversation-preview">${escapeHtml(conversation.lastMessage || "")}</span>
</li>`;
    })
    .join("");

  elements.conversationList.innerHTML = items || '<li class="conversation-empty">no conversations</li>';

  const buttons = elements.conversationList.querySelectorAll(".conversation-select");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const item = button.closest(".conversation-item");
      const id = item?.dataset.id;
      if (id) {
        void openConversation(id, true);
      }
    });
  }
}

function renderMessages() {
  const html = state.messages
    .map((message) => {
      const roleClass = `role-${message.role}`;
      const meta = message.status === "streaming" ? '<em class="meta">thinking/streaming</em>' : "";
      const label = message.role === "user" ? "user" : message.role;
      return `
<article class="message ${roleClass}">
  <header><span class="label">${label}</span> ${meta}</header>
  <div class="content">${escapeHtml(message.content)}</div>
</article>`;
    })
    .join("");

  elements.messages.innerHTML = html || '<p class="empty-chat">No messages yet.</p>';
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateActionButtons() {
  const current = state.conversations.find((item) => item.id === state.currentConversationId);
  const isArchived = current?.status === "archived";
  elements.archiveConversation.disabled = !current || isArchived;
  elements.resumeConversation.disabled = !current || !isArchived;
  elements.deleteConversation.disabled = !current;
}

async function refreshConversationList() {
  const payload = await api("/api/conversations", { method: "GET" });
  state.conversations = payload.conversations;
  renderConversationList();
  updateActionButtons();
}

async function createConversation(title = "") {
  const payload = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  await refreshConversationList();
  return payload.conversation;
}

function parseConversationIdFromPath() {
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function pushConversationRoute(id) {
  const nextPath = `/c/${encodeURIComponent(id)}`;
  if (window.location.pathname !== nextPath) {
    history.pushState({ conversationId: id }, "", nextPath);
  }
}

async function openConversation(id, pushRoute) {
  const payload = await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "GET" });
  state.currentConversationId = id;
  state.messages = payload.messages;
  elements.conversationPath.textContent = `/c/${id}`;
  renderConversationList();
  renderMessages();
  updateActionButtons();

  if (pushRoute) {
    pushConversationRoute(id);
  }

  const eventsPayload = await api(`/api/conversations/${encodeURIComponent(id)}/events`, { method: "GET" });
  elements.logs.textContent = eventsPayload.events
    .map((entry) => `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.type}`)
    .join("\n");
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

async function ensureInitialConversation() {
  await refreshConversationList();
  const pathConversationId = parseConversationIdFromPath();

  if (pathConversationId) {
    const exists = state.conversations.find((item) => item.id === pathConversationId);
    if (exists) {
      await openConversation(pathConversationId, false);
      return;
    }
  }

  if (state.conversations.length > 0) {
    await openConversation(state.conversations[0].id, true);
    return;
  }

  const created = await createConversation();
  await openConversation(created.id, true);
}

async function runConversationAction(action) {
  if (!state.currentConversationId) {
    return;
  }

  await api(`/api/conversations/${encodeURIComponent(state.currentConversationId)}/${action}`, {
    method: "POST",
  });

  await refreshConversationList();

  if (action === "delete") {
    if (state.conversations.length === 0) {
      const created = await createConversation();
      await openConversation(created.id, true);
      return;
    }
    await openConversation(state.conversations[0].id, true);
    return;
  }

  if (state.currentConversationId) {
    await openConversation(state.currentConversationId, false);
  }
}

async function readSse(response, handlers) {
  if (!response.body) {
    throw new Error("stream unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");

      let event = "message";
      const dataLines = [];
      const lines = block.split("\n");

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      const joined = dataLines.join("\n");
      let payload = joined;
      try {
        payload = JSON.parse(joined);
      } catch {
        // ignored
      }

      if (handlers[event]) {
        await handlers[event](payload);
      }
    }
  }
}

function connectEventStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const source = new EventSource("/api/events/stream");
  state.eventSource = source;

  source.addEventListener("engine", (rawEvent) => {
    try {
      const event = JSON.parse(rawEvent.data);
      appendLog(event);
      if (event.conversationId === state.currentConversationId) {
        if (event.type === "message.assistant.delta") {
          setStatus("streaming", "active");
        }
        if (event.type === "message.assistant.completed") {
          setStatus("done", "ok");
        }
        if (event.type === "gateway.error") {
          setStatus("error", "error");
        }
      }
    } catch {
      // ignored
    }
  });

  source.onerror = () => {
    setStatus("event stream reconnecting", "error");
  };
}

async function sendMessage(content) {
  if (!state.currentConversationId) {
    throw new Error("No conversation selected");
  }
  if (state.streamInFlight) {
    throw new Error("A response is already streaming");
  }

  state.streamInFlight = true;
  setStatus("thinking", "active");

  const userMessage = {
    id: `tmp-user-${crypto.randomUUID()}`,
    role: "user",
    content,
    status: "done",
  };
  const assistantMessage = {
    id: `tmp-assistant-${crypto.randomUUID()}`,
    role: "assistant",
    content: "",
    status: "streaming",
  };

  state.messages.push(userMessage, assistantMessage);
  renderMessages();

  const response = await fetch(
    `/api/conversations/${encodeURIComponent(state.currentConversationId)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );

  if (!response.ok) {
    state.streamInFlight = false;
    const payload = await response.json().catch(() => ({ error: "request failed" }));
    throw new Error(payload.error || `request failed (${response.status})`);
  }

  await readSse(response, {
    start: async (payload) => {
      assistantMessage.id = payload.assistantMessageId || assistantMessage.id;
    },
    delta: async (payload) => {
      assistantMessage.content += payload.delta || "";
      assistantMessage.status = "streaming";
      renderMessages();
    },
    error: async (payload) => {
      assistantMessage.status = "error";
      assistantMessage.content = `[error] ${payload.message || "generation failed"}`;
      setStatus("error", "error");
      renderMessages();
    },
    done: async () => {
      assistantMessage.status = "done";
      state.streamInFlight = false;
      setStatus("done", "ok");
      renderMessages();
      await refreshConversationList();
      if (state.currentConversationId) {
        await openConversation(state.currentConversationId, false);
      }
    },
  });

  state.streamInFlight = false;
}

function bindUi() {
  elements.newConversation.addEventListener("click", async () => {
    try {
      const conversation = await createConversation();
      await openConversation(conversation.id, true);
    } catch (error) {
      setStatus(String(error), "error");
    }
  });

  elements.archiveConversation.addEventListener("click", async () => {
    try {
      await runConversationAction("archive");
    } catch (error) {
      setStatus(String(error), "error");
    }
  });

  elements.resumeConversation.addEventListener("click", async () => {
    try {
      await runConversationAction("resume");
    } catch (error) {
      setStatus(String(error), "error");
    }
  });

  elements.deleteConversation.addEventListener("click", async () => {
    try {
      await runConversationAction("delete");
    } catch (error) {
      setStatus(String(error), "error");
    }
  });

  elements.logout.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/login";
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = elements.input.value.trim();
    if (!content) {
      return;
    }

    elements.input.value = "";

    try {
      await sendMessage(content);
    } catch (error) {
      state.streamInFlight = false;
      setStatus(String(error), "error");
      await refreshConversationList();
      if (state.currentConversationId) {
        await openConversation(state.currentConversationId, false);
      }
    }
  });

  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  window.addEventListener("popstate", () => {
    const pathConversationId = parseConversationIdFromPath();
    if (pathConversationId) {
      void openConversation(pathConversationId, false).catch((error) => {
        setStatus(String(error), "error");
      });
    }
  });
}

async function boot() {
  setStatus(`session: ${state.username}`, "muted");
  bindUi();
  connectEventStream();
  await ensureInitialConversation();
  setStatus("ready", "ok");
}

void boot().catch((error) => {
  setStatus(String(error), "error");
});
