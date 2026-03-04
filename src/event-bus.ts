export interface EngineEvent {
  id: string;
  createdAt: string;
  type: string;
  userId: string | null;
  conversationId: string | null;
  payload: Record<string, unknown>;
}

interface Subscriber {
  id: number;
  userId: string;
  conversationId: string | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

function toSseBlock(eventName: string, payload: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function toComment(comment: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`: ${comment}\n\n`);
}

export class EventBus {
  private nextId = 1;
  private subscribers = new Map<number, Subscriber>();

  createStream(userId: string, conversationId: string | null = null): ReadableStream<Uint8Array> {
    let subscriberId = 0;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = this.nextId++;
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(toComment("keepalive"));
          } catch {
            this.removeSubscriber(subscriberId);
          }
        }, 15_000);

        this.subscribers.set(subscriberId, {
          id: subscriberId,
          userId,
          conversationId,
          controller,
          heartbeat,
        });

        controller.enqueue(toComment("ready"));
      },
      cancel: () => {
        this.removeSubscriber(subscriberId);
      },
    });
  }

  publish(event: EngineEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.userId !== event.userId) {
        continue;
      }
      if (
        subscriber.conversationId &&
        event.conversationId &&
        subscriber.conversationId !== event.conversationId
      ) {
        continue;
      }
      if (subscriber.conversationId && !event.conversationId) {
        continue;
      }

      try {
        subscriber.controller.enqueue(toSseBlock("engine", event));
      } catch {
        this.removeSubscriber(subscriber.id);
      }
    }
  }

  close(): void {
    for (const subscriber of this.subscribers.values()) {
      clearInterval(subscriber.heartbeat);
      try {
        subscriber.controller.close();
      } catch {
        // ignored
      }
    }
    this.subscribers.clear();
  }

  private removeSubscriber(id: number): void {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) {
      return;
    }
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(id);
    try {
      subscriber.controller.close();
    } catch {
      // ignored
    }
  }
}
