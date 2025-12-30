import { beforeEach, describe, expect, it } from 'vitest';

import worker, {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  DurableObjectStub,
  Env,
  RateLimiter,
  RegistryRoomDurableObject,
  WorkerExecutionContext,
} from './index';

declare const Buffer: {
  from(data: string, encoding: string): { toString(encoding: string): string };
};

function deepClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

class MockDurableObjectStorage implements DurableObjectStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.store.has(key)) {
      return undefined;
    }
    return deepClone(this.store.get(key) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, deepClone(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class MockDurableObjectId implements DurableObjectId {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

class MockDurableObjectState implements DurableObjectState {
  public readonly storage: DurableObjectStorage;

  constructor(public readonly id: DurableObjectId) {
    this.storage = new MockDurableObjectStorage();
  }
}

class MockDurableObjectStub implements DurableObjectStub {
  constructor(private readonly object: RegistryRoomDurableObject) {}

  async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    if (input instanceof Request) {
      return this.object.fetch(input);
    }
    const request = new Request(input, init);
    return this.object.fetch(request);
  }
}

class MockDurableObjectNamespace implements DurableObjectNamespace {
  private readonly objects = new Map<string, RegistryRoomDurableObject>();

  constructor(private readonly env: Env) {}

  idFromName(name: string): DurableObjectId {
    return new MockDurableObjectId(name);
  }

  get(id: DurableObjectId): DurableObjectStub {
    const key = id.toString();
    let object = this.objects.get(key);
    if (!object) {
      const state = new MockDurableObjectState(id);
      object = new RegistryRoomDurableObject(state, this.env);
      this.objects.set(key, object);
    }
    return new MockDurableObjectStub(object);
  }
}

class MockRateLimiter implements RateLimiter {
  async limit(_input: { key: string }): Promise<{ success: boolean }> {
    return { success: true };
  }
}

if (!(globalThis as { btoa?: typeof btoa }).btoa) {
  (globalThis as { btoa?: typeof btoa }).btoa = (data: string) => Buffer.from(data, 'binary').toString('base64');
}

describe('registry worker', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      RATE_LIMIT_CREATE: new MockRateLimiter(),
      RATE_LIMIT_PUBLIC: new MockRateLimiter(),
      RATE_LIMIT_JOIN_IP: new MockRateLimiter(),
      RATE_LIMIT_JOIN_ROOM: new MockRateLimiter(),
      RATE_LIMIT_POLL_ROOM: new MockRateLimiter(),
      RATE_LIMIT_MUTATION_ROOM: new MockRateLimiter(),
      ALLOWED_ORIGINS: 'https://game.test',
    } as Env;
    env.REGISTRY_ROOMS = new MockDurableObjectNamespace(env);
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

  it('preserves SDP data when candidates are appended', async () => {
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
        body: JSON.stringify({ joinCode: created.joinCode, guestUserName: 'Bob1997' }),
      }),
      env,
      createExecutionContext()
    );
    const join = await joinResponse.json();

    const sdp = 'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=audio 9 RTP/AVP 0';
    await worker.fetch(
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

    const candidateResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': join.guestToken,
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
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    const snapshot = await snapshotResponse.json();
    expect(snapshot.offer.type).toBe('offer');

    const candidatesResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidates`, {
        headers: {
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    const candidates = await candidatesResponse.json();
    expect(candidates.items).toHaveLength(1);
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

  it('deduplicates candidates while keeping the offer', async () => {
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
        body: JSON.stringify({ joinCode: created.joinCode, guestUserName: 'Bob1997' }),
      }),
      env,
      createExecutionContext()
    );
    const join = await joinResponse.json();

    const sdp = 'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=audio 9 RTP/AVP 0';
    await worker.fetch(
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

    const candidateBody = JSON.stringify({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 3478 typ host' });
    await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
        body: candidateBody,
      }),
      env,
      createExecutionContext()
    );
    const duplicateResponse = await worker.fetch(
      new Request(`https://example.com/rooms/${created.code}/candidate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-registry-version': '1',
          'x-access-token': created.ownerToken,
          Origin: origin,
        },
        body: candidateBody,
      }),
      env,
      createExecutionContext()
    );
    expect(duplicateResponse.status).toBe(204);

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
    const candidates = await candidatesResponse.json();
    expect(candidates.items).toHaveLength(1);

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
    const snapshot = await snapshotResponse.json();
    expect(snapshot.offer.type).toBe('offer');
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
