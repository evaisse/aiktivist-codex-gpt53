function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function loginPageHtml(errorMessage = ""): string {
  const error = errorMessage
    ? `<p class=\"login-error\" role=\"alert\">${escapeHtml(errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>aiktivist | login</title>
    <link rel="stylesheet" href="/assets/styles.css" />
  </head>
  <body class="page-login">
    <main class="login-shell">
      <h1>aiktivist</h1>
      <p class="login-meta">secure session required</p>
      ${error}
      <form id="login-form" class="login-form" method="post" action="/api/login">
        <label>
          <span>username</span>
          <input type="text" name="username" autocomplete="username" required />
        </label>
        <label>
          <span>password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit">login</button>
      </form>
      <p class="login-meta">credentials are validated server-side only</p>
    </main>
    <script>
      const form = document.getElementById("login-form");
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = {
          username: String(formData.get("username") || "").trim(),
          password: String(formData.get("password") || ""),
        };

        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: "login failed" }));
          const errorNode = document.querySelector(".login-error") || document.createElement("p");
          errorNode.className = "login-error";
          errorNode.textContent = body.error || "login failed";
          form.before(errorNode);
          return;
        }

        const params = new URLSearchParams(window.location.search);
        const next = params.get("next") || "/";
        window.location.href = next;
      });
    </script>
  </body>
</html>`;
}

export function appPageHtml(username: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>aiktivist</title>
    <link rel="stylesheet" href="/assets/styles.css" />
  </head>
  <body>
    <main id="app" class="app" data-username="${escapeHtml(username)}">
      <aside class="sidebar">
        <header class="pane-header">
          <span class="pane-title">conversations</span>
          <button id="new-conversation" class="link-like" type="button">+ new</button>
        </header>
        <ul id="conversation-list" class="conversation-list"></ul>
      </aside>

      <section class="chat-pane">
        <header class="pane-header">
          <span id="conversation-path" class="pane-title">/</span>
          <div class="pane-actions">
            <button id="archive-conversation" class="link-like" type="button">archive</button>
            <button id="resume-conversation" class="link-like" type="button">resume</button>
            <button id="delete-conversation" class="link-like danger" type="button">delete</button>
            <button id="logout" class="link-like" type="button">logout</button>
          </div>
        </header>

        <section id="messages" class="messages" aria-live="polite"></section>

        <footer class="composer-wrap">
          <div id="status-line" class="status-line">idle</div>
          <form id="composer" class="composer">
            <label class="sr-only" for="message-input">prompt</label>
            <textarea id="message-input" placeholder="> type your prompt" rows="2" required></textarea>
            <button type="submit">send</button>
          </form>
        </footer>
      </section>

      <aside class="logs-pane">
        <header class="pane-header">
          <span class="pane-title">runtime events</span>
        </header>
        <pre id="logs" class="logs"></pre>
      </aside>
    </main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}
