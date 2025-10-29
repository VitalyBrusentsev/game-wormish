import { beforeEach, describe, expect, it } from 'vitest';

import worker, {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  DurableObjectStub,
  Env,
  RegistryRoomDurableObject,
  WorkerExecutionContext,
} from './index';

declare const Buffer: {
  from(data: string, encoding: string): { toString(encoding: string): string };
};

class MemoryDurableObjectStorage implements DurableObjectStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  debugPeek(key: string): string | null {
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
}

class RecordingKV extends MemoryKV {
  private overrides = new Map<string, Array<string | null>>();

  public readonly getRequests: Array<{
    key: string;
    options?: KVNamespaceGetOptions<string>;
  }> = [];

  queueGetOverride(key: string, value: string | null): void {
    const queue = this.overrides.get(key);
    if (queue) {
      queue.push(value);
    } else {
      this.overrides.set(key, [value]);
    }
  }

  override async get(key: string, options?: KVNamespaceGetOptions<string>): Promise<string | null> {
    this.getRequests.push({ key, options });
    const queue = this.overrides.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) {
        this.overrides.delete(key);
      }
      return next ?? null;
    }
    return super.get(key, options);
  }
}

class MemoryDurableObjectState implements DurableObjectState {
  storage: DurableObjectStorage = new MemoryDurableObjectStorage();

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

class MemoryDurableObjectStub implements DurableObjectStub {
  constructor(private readonly object: RegistryRoomDurableObject) {}

  fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    return this.object.fetch(request);
  }
}

interface MemoryDurableObjectId extends DurableObjectId {
  name: string;
}

class MemoryDurableObjectNamespace implements DurableObjectNamespace {
  private objects = new Map<string, RegistryRoomDurableObject>();

  idFromName(name: string): MemoryDurableObjectId {
    return { name };
  }

  get(id: DurableObjectId): DurableObjectStub {
    const key = (id as MemoryDurableObjectId).name;
    const existing = this.objects.get(key);
    if (existing) {
      return new MemoryDurableObjectStub(existing);
    }
    const object = new RegistryRoomDurableObject(new MemoryDurableObjectState(), {} as Env);
    this.objects.set(key, object);
    return new MemoryDurableObjectStub(object);
  }
}

if (!(globalThis as { btoa?: typeof btoa }).btoa) {
  (globalThis as { btoa?: typeof btoa }).btoa = (data: string) => Buffer.from(data, 'binary').toString('base64');
}

describe('registry worker', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      REGISTRY_ROOMS: new MemoryDurableObjectNamespace(),
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

    const created = await createResponse.json();
    expect(createResponse.status).toBe(201);
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

  it('preserves SDP data when candidates race with stale KV replicas', async () => {
    const origin = 'https://game.test';
    const kv = new RecordingKV();
    env.REGISTRY_KV = kv;

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

    const roomKey = `room:${created.code}`;
    const staleSnapshot = kv.debugPeek(roomKey);
    expect(staleSnapshot).not.toBeNull();

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

    const freshSnapshot = kv.debugPeek(roomKey);
    expect(freshSnapshot).not.toBeNull();
    expect(freshSnapshot).not.toBe(staleSnapshot);
    const parsedFresh = JSON.parse(freshSnapshot!);
    expect(parsedFresh.offer?.type).toBe('offer');

    kv.queueGetOverride(roomKey, staleSnapshot);

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

    const storedRoom = kv.debugPeek(roomKey);
    expect(storedRoom).not.toBeNull();
    const parsedRoom = JSON.parse(storedRoom!);
    expect(parsedRoom.offer?.type).toBe('offer');

    const guestIceKey = `ice:${created.code}:guest`;
    const guestIce = kv.debugPeek(guestIceKey);
    expect(guestIce).not.toBeNull();
    const parsedGuestIce = JSON.parse(guestIce!);
    expect(parsedGuestIce).toHaveLength(1);

    const roomGets = kv.getRequests.filter((req) => req.key === roomKey);
    expect(roomGets.length).toBeGreaterThan(0);
    for (const req of roomGets) {
      expect(req.options?.cacheTtl).toBe(0);
    }

    const iceGets = kv.getRequests.filter((req) => req.key === guestIceKey);
    expect(iceGets.length).toBeGreaterThan(0);
    for (const req of iceGets) {
      expect(req.options?.cacheTtl).toBe(0);
    }
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

  it('keeps the stored offer when candidate updates see a stale room snapshot', async () => {
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
    const joined = await joinResponse.json();

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
          'x-access-token': joined.guestToken,
          Origin: origin,
        },
      }),
      env,
      createExecutionContext()
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.offer).toBeTruthy();
    expect(snapshot.offer.sdp).toBe(sdp);
    expect(snapshot.answer).toBeNull();
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
