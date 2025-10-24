export class EventEmitter<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<(payload: any) => void>>();

  on<TKey extends keyof TEvents>(event: TKey, listener: (payload: TEvents[TKey]) => void): void {
    const existing = this.listeners.get(event) ?? new Set();
    existing.add(listener as (payload: any) => void);
    this.listeners.set(event, existing);
  }

  off<TKey extends keyof TEvents>(event: TKey, listener: (payload: TEvents[TKey]) => void): void {
    const existing = this.listeners.get(event);
    existing?.delete(listener as (payload: any) => void);
    if (existing && existing.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }

    for (const listener of existing) {
      listener(payload);
    }
  }
}
