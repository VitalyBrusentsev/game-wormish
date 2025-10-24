import { beforeEach, describe, expect, it } from 'vitest';

import worker, {
  Env,
  KVNamespace,
  KVNamespaceGetOptions,
  KVNamespacePutOptions,
  WorkerExecutionContext,
} from './index';

declare const Buffer: {
  from(data: string, encoding: string): { toString(encoding: string): string };
};

class MemoryKV implements KVNamespace {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string, _options?: KVNamespaceGetOptions<string>): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiration && entry.expiration <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    let expiration: number | undefined;
    if (options?.expiration) {
      expiration = options.expiration * 1000;
    } else if (options?.expirationTtl) {
      expiration = Date.now() + options.expirationTtl * 1000;
    }
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

if (!(globalThis as { btoa?: typeof btoa }).btoa) {
  (globalThis as { btoa?: typeof btoa }).btoa = (data: string) => Buffer.from(data, 'binary').toString('base64');
}

describe('registry worker', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      REGISTRY_KV: new MemoryKV(),
      ALLOWED_ORIGINS: 'https://game.test',
    } as Env;
  });

  it('supports the happy path room lifecycle', async () => {
    const origin = 'https://game.test';
    const createResponse = await worker.fetch(
      new Request('https://example.com/rooms', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          Origin: origin,
        },
        body: JSON.stringify({ hostUserName: 'Alice1996' }),
      }),
      env,
      createExecutionContext()
    );

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(typeof created.code).toBe('string');
    expect(created.code).toHaveLength(8);
    expect(created.joinCode).toHaveLength(6);
    expect(typeof created.ownerToken).toBe('string');

    const lookupResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/public`, {
        headers: { Origin: origin },
      }),
      env,
      createExecutionContext()
    );
    expect(lookupResponse.status).toBe(200);
    const lookup = await lookupResponse.json();
    expect(lookup.status).toBe('open');
    expect(lookup.hostUserName).toBe('Alice1996');

    const joinResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          Origin: origin,
        },
        body: JSON.stringify({ joinCode: created.joinCode, guestUserName: 'Bob1997' }),
      }),
      env,
      createExecutionContext()
    );
    expect(joinResponse.status).toBe(200);
    const join = await joinResponse.json();
    expect(typeof join.guestToken).toBe('string');

    const sdp = 'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=audio 9 RTP/AVP 0';

    const offerResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/offer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
        body: JSON.stringify({ type: 'offer', sdp }),
      }),
      env,
      createExecutionContext()
    );
    expect(offerResponse.status).toBe(204);

    const answerResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/answer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': join.guestToken,
          Origin: origin,
        },
        body: JSON.stringify({ type: 'answer', sdp }),
      }),
      env,
      createExecutionContext()
    );
    expect(answerResponse.status).toBe(204);

    const candidateResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
        body: JSON.stringify({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 3478 typ host' }),
      }),
      env,
      createExecutionContext()
    );
    expect(candidateResponse.status).toBe(204);

    const snapshotResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}`, {
        headers: {
          'x-access-token': join.guestToken,
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.status).toBe('paired');
    expect(snapshot.offer.type).toBe('offer');
    expect(snapshot.answer.type).toBe('answer');

    const candidatesResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidates`, {
        headers: {
          'x-access-token': join.guestToken,
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    expect(candidatesResponse.status).toBe(200);
    const candidates = await candidatesResponse.json();
    expect(Array.isArray(candidates.items)).toBe(true);
    expect(candidates.items[0].candidate).toContain('candidate:1');

    const closeResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/close`, {
        method: 'POST',
        headers: {
          'x-access-token': created.ownerToken,
          'x-registry-version': '1',
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    expect(closeResponse.status).toBe(204);
  });

  it('allows host to close an open room', async () => {
    const origin = 'https://game.test';
    const createResponse = await worker.fetch(
      new Request('https://example.com/rooms', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          Origin: origin,
        },
        body: JSON.stringify({ hostUserName: 'Alice1996' }),
      }),
      env,
      createExecutionContext()
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const closeResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/close`, {
        method: 'POST',
        headers: {
          'x-access-token': created.ownerToken,
          'x-registry-version': '1',
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );

    expect(closeResponse.status).toBe(204);
  });

  it('rejects invalid join attempts', async () => {
    const origin = 'https://game.test';
    const createResponse = await worker.fetch(
      new Request('https://example.com/rooms', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          Origin: origin,
        },
        body: JSON.stringify({ hostUserName: 'Alice1996' }),
      }),
      env,
      createExecutionContext()
    );
    const created = await createResponse.json();

    const joinResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/join`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          Origin: origin,
        },
        body: JSON.stringify({ joinCode: '000000', guestUserName: 'Bob1997' }),
      }),
      env,
      createExecutionContext()
    );

    expect(joinResponse.status).toBe(403);
    const error = await joinResponse.json();
    expect(error.error.code).toBe('bad_join_code');
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
