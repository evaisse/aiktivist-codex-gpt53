import { createApp } from "./app";

const app = await createApp();

const server = Bun.serve({
  hostname: app.config.host,
  port: app.config.port,
  fetch: app.fetch,
});

console.log(`aiktivist listening on ${server.url}`);
