import { describe, expect, it } from 'vitest';

import worker, { WorkerExecutionContext } from './index';

describe('current time worker', () => {
  it('returns an ISO timestamp payload', async () => {
    const response = await worker.fetch(new Request('https://example.com'), {} as never, createExecutionContext());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const payload: { currentTime: string } = await response.json();

    expect(typeof payload.currentTime).toBe('string');
    expect(() => new Date(payload.currentTime)).not.toThrow();
  });
});

function createExecutionContext(): WorkerExecutionContext {
  return {
    waitUntil(_promise: Promise<unknown>): void {
      // no-op for tests
    },
    passThroughOnException(): void {
      // no-op for tests
    },
  };
}
