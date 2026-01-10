export type Unsubscribe = () => void;

export type SubscribeOptions = {
  signal?: AbortSignal;
};

export class EventBus<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<(event: unknown) => void>>();

  on<K extends keyof EventMap>(
    type: K,
    handler: (event: EventMap[K]) => void,
    options?: SubscribeOptions
  ): Unsubscribe {
    const signal = options?.signal;
    if (signal?.aborted) return () => {};

    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }

    const wrapped = handler as unknown as (event: unknown) => void;
    handlers.add(wrapped);

    let removed = false;
    const unsubscribe = () => {
      if (removed) return;
      removed = true;
      const current = this.listeners.get(type);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) {
        this.listeners.delete(type);
      }
    };

    if (signal) {
      const abortHandler = () => unsubscribe();
      signal.addEventListener("abort", abortHandler, { once: true });
      return () => {
        signal.removeEventListener("abort", abortHandler);
        unsubscribe();
      };
    }

    return unsubscribe;
  }

  once<K extends keyof EventMap>(
    type: K,
    handler: (event: EventMap[K]) => void,
    options?: SubscribeOptions
  ): Unsubscribe {
    let unsubscribe: Unsubscribe = () => {};
    unsubscribe = this.on(
      type,
      (event) => {
        unsubscribe();
        handler(event);
      },
      options
    );
    return unsubscribe;
  }

  emit<K extends keyof EventMap>(type: K, event: EventMap[K]): void {
    const handlers = this.listeners.get(type);
    if (!handlers || handlers.size === 0) return;

    const queue = Array.from(handlers);
    for (const handler of queue) {
      try {
        (handler as (event: EventMap[K]) => void)(event);
      } catch (error) {
        console.error(`Unhandled '${String(type)}' event handler error`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(): number;
  listenerCount<K extends keyof EventMap>(type: K): number;
  listenerCount(type?: keyof EventMap): number {
    if (type === undefined) {
      let total = 0;
      for (const handlers of this.listeners.values()) {
        total += handlers.size;
      }
      return total;
    }
    return this.listeners.get(type)?.size ?? 0;
  }
}

