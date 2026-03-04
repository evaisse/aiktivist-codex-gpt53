import type { AppConfig } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayInput {
  messages: ChatMessage[];
}

export type GatewayStreamEvent =
  | { kind: "delta"; text: string; raw: Record<string, unknown> }
  | { kind: "done"; raw: Record<string, unknown> };

export interface ChatGateway {
  stream(input: GatewayInput): AsyncGenerator<GatewayStreamEvent>;
}

interface OpenRouterLikeResponse {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}

export class OpenRouterGateway implements ChatGateway {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async *stream(input: GatewayInput): AsyncGenerator<GatewayStreamEvent> {
    if (!this.config.openRouterApiKey) {
      if (!this.config.allowMockGateway) {
        throw new Error("OPENROUTER_API_KEY is required when OPENROUTER_ALLOW_MOCK is disabled");
      }
      yield* this.mockStream(input);
      return;
    }

    const payload = {
      model: this.config.openRouterModel,
      stream: true,
      messages: input.messages,
    };

    const response = await this.fetchFn(this.config.openRouterBaseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${body.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("OpenRouter response has no body");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let eventEnd = buffer.indexOf("\n\n");
      while (eventEnd !== -1) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        eventEnd = buffer.indexOf("\n\n");

        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        for (const dataLine of dataLines) {
          if (!dataLine) {
            continue;
          }
          if (dataLine === "[DONE]") {
            yield { kind: "done", raw: { done: true } };
            return;
          }

          let parsed: OpenRouterLikeResponse;
          try {
            parsed = JSON.parse(dataLine);
          } catch {
            continue;
          }

          const text = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
          if (text) {
            yield {
              kind: "delta",
              text,
              raw: parsed as Record<string, unknown>,
            };
          }
        }
      }
    }

    yield { kind: "done", raw: { done: true, reason: "stream_closed" } };
  }

  private async *mockStream(input: GatewayInput): AsyncGenerator<GatewayStreamEvent> {
    const userMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const simulated = `Mock OpenRouter stream: ${userMessage || "No prompt"}`;

    for (const token of simulated.split(/(\s+)/)) {
      if (!token) {
        continue;
      }
      await Bun.sleep(5);
      yield {
        kind: "delta",
        text: token,
        raw: { provider: "mock", token },
      };
    }

    yield { kind: "done", raw: { provider: "mock", done: true } };
  }
}
