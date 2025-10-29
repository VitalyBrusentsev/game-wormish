/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
  REGISTRY_ROOMS: DurableObjectNamespace;
  ROOM_TTL_OPEN?: string;
  ROOM_TTL_JOINED?: string;
  ROOM_TTL_PAIRED?: string;
  ROOM_TTL_CLOSED?: string;
  ICE_TTL?: string;
  ALLOWED_ORIGINS?: string;
}

export interface DurableObjectId {}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type RoomStatus = 'open' | 'joined' | 'paired' | 'closed';

type SessionDescriptionType = 'offer' | 'answer';

interface SessionDescription {
  type: SessionDescriptionType;
  sdp: string;
}

interface RoomRecord {
  code: string;
  hostUserName: string;
  guestUserName?: string;
  joinCode?: string;
  ownerToken: string;
  guestToken?: string;
  offer?: SessionDescription;
  answer?: SessionDescription;
  status: RoomStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface IceCandidateInput {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

interface CandidateRecord extends IceCandidateInput {}

const HEADER_ACCESS_TOKEN = 'x-access-token';
const HEADER_VERSION = 'x-registry-version';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 20 * 1024;
const MAX_CANDIDATE_BYTES = 1024;
const MAX_CANDIDATES_PER_PEER = 40;
const REQUIRED_SDP_LINES = ['v=', 'o=', 's=', 't=', 'm='];
const BASE36_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const DEFAULT_TTLS: Record<RoomStatus, number> = {
  open: 60,
  joined: 180,
  paired: 300,
  closed: 15,
};

const DEFAULT_ICE_TTL = 300;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RegistryError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly messageText: string,
    public readonly retryable = false,
    public readonly retryAfterSec?: number
  ) {
    super(messageText);
  }
}

type AllowedOrigin = string | null;

type RouteHandler = (
  request: Request,
  env: Env,
  roomCode: string | null,
  ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
) => Promise<Response>;

const ROOM_CODE_LENGTH = 8;
const JOIN_CODE_LENGTH = 6;

function getAllowedOrigins(env: Env): string[] {
  if (!env.ALLOWED_ORIGINS) {
    return [];
  }

  return env.ALLOWED_ORIGINS.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveCorsOrigin(request: Request, env: Env): AllowedOrigin {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return null;
  }
  const allowedOrigins = getAllowedOrigins(env);
  if (allowedOrigins.length === 0) {
    return null;
  }
  if (allowedOrigins.includes(origin)) {
    return origin;
  }
  return null;
}

function applyCorsHeaders(response: Response, corsOrigin: AllowedOrigin): Response {
  if (!corsOrigin) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', corsOrigin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function optionsResponse(corsOrigin: AllowedOrigin): Response {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token, X-Registry-Version');
  headers.set('Access-Control-Max-Age', '600');
  headers.set('cache-control', 'no-store');
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status: 204, headers });
}

function jsonResponse(data: unknown, status = 200, corsOrigin: AllowedOrigin): Response {
  const headers = new Headers(JSON_HEADERS);
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function emptyResponse(status: number, corsOrigin: AllowedOrigin): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status, headers });
}

function errorResponse(error: RegistryError, corsOrigin: AllowedOrigin): Response {
  const payload: Record<string, unknown> = {
    error: {
      code: error.code,
      message: error.messageText,
      retryable: error.retryable,
    },
  };
  if (typeof error.retryAfterSec === 'number') {
    (payload.error as Record<string, unknown>).retryAfterSec = error.retryAfterSec;
  }
  return jsonResponse(payload, error.httpStatus, corsOrigin);
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new RegistryError(400, 'bad_json', 'Request body must be valid JSON', false);
  }
}

function ensureMutationHeader(request: Request): void {
  const version = request.headers.get(HEADER_VERSION);
  if (!version) {
    throw new RegistryError(400, 'missing_version', 'Missing X-Registry-Version header', false);
  }
}

function getAccessToken(request: Request, required: boolean): string | null {
  const token = request.headers.get(HEADER_ACCESS_TOKEN);
  if (required && !token) {
    throw new RegistryError(403, 'forbidden', 'Missing access token', false);
  }
  return token;
}

function validateUserName(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new RegistryError(400, 'bad_username', 'Username must be a string', false);
  }
  if (value.length < 1 || value.length > 32) {
    throw new RegistryError(400, 'bad_username', 'Username length must be 1-32 characters', false);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new RegistryError(400, 'bad_username', 'Username must match [a-zA-Z0-9_-]+', false);
  }
}

function validateJoinCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    throw new RegistryError(400, 'bad_join_code', 'Join code must be a 6 digit string', false);
  }
}

function validateSdp(description: unknown, expectedType: SessionDescriptionType): SessionDescription {
  if (typeof description !== 'object' || description === null) {
    throw new RegistryError(400, 'bad_sdp', 'SDP payload must be an object', false);
  }
  const { type, sdp } = description as Record<string, unknown>;
  if (type !== expectedType) {
    throw new RegistryError(400, 'bad_sdp', `SDP type must be \"${expectedType}\"`, false);
  }
  if (typeof sdp !== 'string') {
    throw new RegistryError(400, 'bad_sdp', 'SDP must be a string', false);
  }
  const encoder = new TextEncoder();
  const size = encoder.encode(sdp).byteLength;
  if (size > MAX_SDP_BYTES) {
    throw new RegistryError(413, 'bad_sdp', 'SDP is too large', false);
  }
  const trimmed = sdp.trim();
  for (const required of REQUIRED_SDP_LINES) {
    if (!trimmed.includes(`\n${required}`) && !trimmed.startsWith(required)) {
      throw new RegistryError(400, 'bad_sdp', `SDP missing required line ${required}`, false);
    }
  }
  return { type: expectedType, sdp };
}

function validateCandidate(candidate: unknown): IceCandidateInput {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new RegistryError(400, 'bad_candidate', 'Candidate must be an object', false);
  }
  const { candidate: value, sdpMid, sdpMLineIndex } = candidate as Record<string, unknown>;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistryError(400, 'bad_candidate', 'candidate field is required', false);
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength > MAX_CANDIDATE_BYTES) {
    throw new RegistryError(413, 'bad_candidate', 'Candidate is too large', false);
  }
  const result: IceCandidateInput = { candidate: value };
  if (sdpMid !== undefined) {
    if (typeof sdpMid !== 'string') {
      throw new RegistryError(400, 'bad_candidate', 'sdpMid must be a string', false);
    }
    result.sdpMid = sdpMid;
  }
  if (sdpMLineIndex !== undefined) {
    if (typeof sdpMLineIndex !== 'number') {
      throw new RegistryError(400, 'bad_candidate', 'sdpMLineIndex must be a number', false);
    }
    result.sdpMLineIndex = sdpMLineIndex;
  }
  return result;
}

function getRoomTtl(env: Env, status: RoomStatus): number {
  const override = env[`ROOM_TTL_${status.toUpperCase() as 'ROOM_TTL_OPEN'}` as keyof Env];
  if (override) {
    const parsed = parseInt(String(override), 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TTLS[status];
}

function getRoomTtlMap(env: Env): Record<RoomStatus, number> {
  return {
    open: getRoomTtl(env, 'open'),
    joined: getRoomTtl(env, 'joined'),
    paired: getRoomTtl(env, 'paired'),
    closed: getRoomTtl(env, 'closed'),
  };
}

function getIceTtl(env: Env): number {
  if (env.ICE_TTL) {
    const parsed = parseInt(env.ICE_TTL, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_ICE_TTL;
}

async function readBodyText(request: Request): Promise<string> {
  const clone = request.clone();
  const buffer = await clone.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new RegistryError(413, 'body_too_large', 'Request body exceeds limit', true);
  }
  return new TextDecoder().decode(buffer);
}

type RoomAction =
  | 'createRoom'
  | 'getPublicSummary'
  | 'joinRoom'
  | 'setOffer'
  | 'setAnswer'
  | 'appendCandidate'
  | 'getRoomSnapshot'
  | 'getCandidates'
  | 'closeRoom';

interface DurableOk<T> {
  ok: true;
  value: T;
}

interface DurableErr {
  ok: false;
  error: {
    httpStatus: number;
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSec?: number;
  };
}

type DurableRoomResponse<T> = DurableOk<T> | DurableErr;

function getRoomStub(env: Env, code: string): DurableObjectStub {
  const id = env.REGISTRY_ROOMS.idFromName(code);
  return env.REGISTRY_ROOMS.get(id);
}

async function roomAction<T>(env: Env, code: string, action: RoomAction, payload: unknown): Promise<T> {
  const stub = getRoomStub(env, code);
  const request = new Request('https://registry.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const response = await stub.fetch(request);
  const data = (await response.json()) as DurableRoomResponse<T>;
  if (!data.ok) {
    throw new RegistryError(
      data.error.httpStatus,
      data.error.code,
      data.error.message,
      data.error.retryable,
      data.error.retryAfterSec
    );
  }
  return data.value;
}

function candidateDedupeKey(candidate: CandidateRecord): string {
  return [candidate.candidate, candidate.sdpMid ?? '', candidate.sdpMLineIndex ?? -1].join('::');
}

interface CandidateStore {
  items: CandidateRecord[];
  expiresAt: number;
}

function oppositeRole(role: 'host' | 'guest'): 'host' | 'guest' {
  return role === 'host' ? 'guest' : 'host';
}

export class RegistryRoomDurableObject {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  private async clearAll(): Promise<void> {
    await Promise.all([
      this.state.storage.delete('room'),
      this.state.storage.delete('candidates:host'),
      this.state.storage.delete('candidates:guest'),
    ]);
  }

  private async loadRoom(): Promise<RoomRecord | null> {
    const room = await this.state.storage.get<RoomRecord>('room');
    if (!room) {
      return null;
    }
    if (room.expiresAt <= Date.now()) {
      await this.clearAll();
      return null;
    }
    return room;
  }

  private async requireRoom(): Promise<RoomRecord> {
    const room = await this.loadRoom();
    if (!room) {
      throw new RegistryError(404, 'not_found', 'Room not found', false);
    }
    return room;
  }

  private ensureRoomAccessible(room: RoomRecord): void {
    if (room.status === 'closed') {
      throw new RegistryError(404, 'not_found', 'Room not found', false);
    }
  }

  private resolveRole(room: RoomRecord, token: string | null): 'host' | 'guest' {
    if (!token) {
      throw new RegistryError(403, 'forbidden', 'Missing access token', false);
    }
    if (token === room.ownerToken) {
      return 'host';
    }
    if (room.guestToken && token === room.guestToken) {
      return 'guest';
    }
    throw new RegistryError(403, 'forbidden', 'Invalid access token', false);
  }

  private async loadCandidates(role: 'host' | 'guest'): Promise<CandidateRecord[]> {
    const store = await this.state.storage.get<CandidateStore>(`candidates:${role}`);
    if (!store) {
      return [];
    }
    if (store.expiresAt <= Date.now()) {
      await this.state.storage.delete(`candidates:${role}`);
      return [];
    }
    return store.items;
  }

  private async saveCandidates(role: 'host' | 'guest', items: CandidateRecord[], ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    await this.state.storage.put(`candidates:${role}`, { items, expiresAt });
  }

  private touchRoom(room: RoomRecord, ttlByStatus: Record<RoomStatus, number>): void {
    const now = Date.now();
    room.updatedAt = now;
    room.expiresAt = now + ttlByStatus[room.status] * 1000;
  }

  private success(value: unknown): Response {
    return new Response(JSON.stringify({ ok: true, value }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  private error(error: RegistryError): Response {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          httpStatus: error.httpStatus,
          code: error.code,
          message: error.messageText,
          retryable: error.retryable,
          retryAfterSec: error.retryAfterSec,
        },
      }),
      {
        status: error.httpStatus,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== 'POST') {
        throw new RegistryError(400, 'bad_action', 'Unsupported method', false);
      }
      const { action, payload } = (await request.json()) as { action: RoomAction; payload: Record<string, unknown> };
      switch (action) {
        case 'createRoom':
          return this.success(await this.handleCreateRoom(payload));
        case 'getPublicSummary':
          return this.success(await this.handleGetPublicSummary());
        case 'joinRoom':
          return this.success(await this.handleJoinRoom(payload));
        case 'setOffer':
          return this.success(await this.handleSetOffer(payload));
        case 'setAnswer':
          return this.success(await this.handleSetAnswer(payload));
        case 'appendCandidate':
          return this.success(await this.handleAppendCandidate(payload));
        case 'getRoomSnapshot':
          return this.success(await this.handleGetRoomSnapshot(payload));
        case 'getCandidates':
          return this.success(await this.handleGetCandidates(payload));
        case 'closeRoom':
          return this.success(await this.handleCloseRoom(payload));
        default:
          throw new RegistryError(400, 'bad_action', 'Unknown durable object action', false);
      }
    } catch (error) {
      if (error instanceof RegistryError) {
        return this.error(error);
      }
      throw error;
    }
  }

  private async handleCreateRoom(payload: Record<string, unknown>): Promise<{ room: RoomRecord }> {
    const hostUserName = payload.hostUserName as string | undefined;
    const joinCode = payload.joinCode as string | undefined;
    const ownerToken = payload.ownerToken as string | undefined;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    const code = payload.code as string | undefined;
    if (!hostUserName || !joinCode || !ownerToken || !ttlByStatus || !code) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const existing = await this.loadRoom();
      if (existing) {
        throw new RegistryError(409, 'room_exists', 'Room already exists', true, 0.1);
      }
      const now = Date.now();
      const room: RoomRecord = {
        code,
        hostUserName,
        joinCode,
        ownerToken,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + ttlByStatus.open * 1000,
      };
      await this.state.storage.put('room', room);
      await this.state.storage.delete('candidates:host');
      await this.state.storage.delete('candidates:guest');
      return { room };
    });
  }

  private async handleGetPublicSummary(): Promise<{ status: RoomStatus; expiresAt: number; hostUserName: string }> {
    const room = await this.requireRoom();
    this.ensureRoomAccessible(room);
    if (room.status !== 'open') {
      throw new RegistryError(404, 'not_found', 'Room not found', false);
    }
    return { status: room.status, expiresAt: room.expiresAt, hostUserName: room.hostUserName };
  }

  private async handleJoinRoom(payload: Record<string, unknown>): Promise<{ guestToken: string; expiresAt: number }> {
    const joinCode = payload.joinCode as string | undefined;
    const guestUserName = payload.guestUserName as string | undefined;
    const guestToken = payload.guestToken as string | undefined;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    if (!joinCode || !guestUserName || !guestToken || !ttlByStatus) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      if (room.status !== 'open') {
        throw new RegistryError(409, 'not_open', 'Room is not open for joining', false);
      }
      if (!room.joinCode || room.joinCode !== joinCode) {
        throw new RegistryError(403, 'bad_join_code', 'Join code is invalid', false);
      }
      room.guestUserName = guestUserName;
      room.guestToken = guestToken;
      delete room.joinCode;
      room.status = 'joined';
      this.touchRoom(room, ttlByStatus);
      await this.state.storage.put('room', room);
      return { guestToken, expiresAt: room.expiresAt };
    });
  }

  private async handleSetOffer(payload: Record<string, unknown>): Promise<{ expiresAt: number }> {
    const token = payload.token as string | null;
    const offer = payload.offer as SessionDescription | undefined;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    if (!offer || !ttlByStatus) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      const role = this.resolveRole(room, token);
      if (role !== 'host') {
        throw new RegistryError(403, 'forbidden', 'Only the host can set the offer', false);
      }
      if (room.status === 'paired' || room.status === 'closed') {
        throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
      }
      room.offer = offer;
      this.touchRoom(room, ttlByStatus);
      await this.state.storage.put('room', room);
      return { expiresAt: room.expiresAt };
    });
  }

  private async handleSetAnswer(payload: Record<string, unknown>): Promise<{ expiresAt: number }> {
    const token = payload.token as string | null;
    const answer = payload.answer as SessionDescription | undefined;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    if (!answer || !ttlByStatus) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      const role = this.resolveRole(room, token);
      if (role !== 'guest') {
        throw new RegistryError(403, 'forbidden', 'Only the guest can set the answer', false);
      }
      if (!room.offer) {
        throw new RegistryError(409, 'no_offer', 'Offer must be set before answer', false);
      }
      if (room.status === 'paired' || room.status === 'closed') {
        throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
      }
      room.answer = answer;
      room.status = 'paired';
      this.touchRoom(room, ttlByStatus);
      await this.state.storage.put('room', room);
      return { expiresAt: room.expiresAt };
    });
  }

  private async handleAppendCandidate(payload: Record<string, unknown>): Promise<{ ok: true }> {
    const token = payload.token as string | null;
    const candidate = payload.candidate as CandidateRecord | undefined;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    const iceTtlSeconds = payload.iceTtlSeconds as number | undefined;
    if (!candidate || !ttlByStatus || !iceTtlSeconds) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      if (room.status === 'closed') {
        throw new RegistryError(409, 'not_open', 'Room is closed', false);
      }
      const role = this.resolveRole(room, token);
      const items = await this.loadCandidates(role);
      const key = candidateDedupeKey(candidate);
      const existing = new Map(items.map((item) => [candidateDedupeKey(item), item] as const));
      if (!existing.has(key)) {
        if (items.length >= MAX_CANDIDATES_PER_PEER) {
          throw new RegistryError(409, 'too_many_candidates', 'Candidate limit reached', true);
        }
        items.push(candidate);
      }
      await this.saveCandidates(role, items, iceTtlSeconds);
      this.touchRoom(room, ttlByStatus);
      await this.state.storage.put('room', room);
      return { ok: true };
    });
  }

  private async handleGetRoomSnapshot(payload: Record<string, unknown>): Promise<{
    status: RoomStatus;
    offer: SessionDescription | null;
    answer: SessionDescription | null;
    updatedAt: number;
    expiresAt: number;
  }> {
    const token = payload.token as string | null;
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      this.resolveRole(room, token);
      return {
        status: room.status,
        offer: room.offer ?? null,
        answer: room.answer ?? null,
        updatedAt: room.updatedAt,
        expiresAt: room.expiresAt,
      };
    });
  }

  private async handleGetCandidates(payload: Record<string, unknown>): Promise<{ items: CandidateRecord[] }> {
    const token = payload.token as string | null;
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      this.ensureRoomAccessible(room);
      const role = this.resolveRole(room, token);
      const items = await this.loadCandidates(oppositeRole(role));
      return { items };
    });
  }

  private async handleCloseRoom(payload: Record<string, unknown>): Promise<{ expiresAt: number }> {
    const token = payload.token as string | null;
    const ttlByStatus = payload.ttlByStatus as Record<RoomStatus, number> | undefined;
    if (!ttlByStatus) {
      throw new RegistryError(400, 'bad_request', 'Missing required fields', false);
    }
    return this.state.blockConcurrencyWhile(async () => {
      const room = await this.requireRoom();
      const role = this.resolveRole(room, token);
      if (role !== 'host') {
        throw new RegistryError(403, 'forbidden', 'Only the host can close the room', false);
      }
      room.status = 'closed';
      this.touchRoom(room, ttlByStatus);
      await this.state.storage.put('room', room);
      return { expiresAt: room.expiresAt };
    });
  }
}

function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function generateRoomCode(): string {
  const bytes = generateRandomBytes(ROOM_CODE_LENGTH);
  let result = '';
  for (let i = 0; i < bytes.length; i += 1) {
    result += BASE36_ALPHABET[bytes[i] % BASE36_ALPHABET.length];
  }
  return result;
}

function generateJoinCode(): string {
  const bytes = generateRandomBytes(4);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return (value % 1_000_000).toString().padStart(JOIN_CODE_LENGTH, '0');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generateToken(): string {
  return base64UrlEncode(generateRandomBytes(32));
}

async function handleCreateRoom(
  request: Request,
  env: Env,
  _roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  ensureMutationHeader(request);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<{ hostUserName?: unknown }>(rawBody);
  validateUserName(body.hostUserName);

  const ttlByStatus = getRoomTtlMap(env);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRoomCode();
    const joinCode = generateJoinCode();
    const ownerToken = generateToken();
    try {
      const result = await roomAction<{ room: RoomRecord }>(env, code, 'createRoom', {
        code,
        hostUserName: body.hostUserName,
        joinCode,
        ownerToken,
        ttlByStatus,
      });
      return jsonResponse(
        {
          code,
          joinCode,
          ownerToken,
          expiresAt: result.room.expiresAt,
        },
        201,
        corsOrigin
      );
    } catch (error) {
      if (error instanceof RegistryError && error.code === 'room_exists') {
        continue;
      }
      throw error;
    }
  }
  throw new RegistryError(503, 'retry', 'Unable to allocate room code', true, 1);
}

async function handlePublicLookup(
  _request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  const summary = await roomAction<{ status: RoomStatus; expiresAt: number; hostUserName: string }>(
    env,
    roomCode,
    'getPublicSummary',
    {}
  );
  return jsonResponse(summary, 200, corsOrigin);
}

async function handleJoinRoom(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureMutationHeader(request);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<{ joinCode?: unknown; guestUserName?: unknown }>(rawBody);
  validateJoinCode(body.joinCode);
  validateUserName(body.guestUserName);
  const guestToken = generateToken();
  const ttlByStatus = getRoomTtlMap(env);
  const result = await roomAction<{ guestToken: string; expiresAt: number }>(env, roomCode, 'joinRoom', {
    joinCode: body.joinCode,
    guestUserName: body.guestUserName,
    guestToken,
    ttlByStatus,
  });
  return jsonResponse(result, 200, corsOrigin);
}

async function handleOffer(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureMutationHeader(request);
  const token = getAccessToken(request, true);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<SessionDescription>(rawBody);
  const ttlByStatus = getRoomTtlMap(env);
  await roomAction(env, roomCode, 'setOffer', {
    token,
    offer: validateSdp(body, 'offer'),
    ttlByStatus,
  });
  return emptyResponse(204, corsOrigin);
}

async function handleAnswer(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureMutationHeader(request);
  const token = getAccessToken(request, true);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<SessionDescription>(rawBody);
  const ttlByStatus = getRoomTtlMap(env);
  await roomAction(env, roomCode, 'setAnswer', {
    token,
    answer: validateSdp(body, 'answer'),
    ttlByStatus,
  });
  return emptyResponse(204, corsOrigin);
}

async function handleCandidate(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureMutationHeader(request);
  const token = getAccessToken(request, true);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<IceCandidateInput>(rawBody);
  const ttlByStatus = getRoomTtlMap(env);
  const iceTtl = getIceTtl(env);
  const validated = validateCandidate(body);
  await roomAction(env, roomCode, 'appendCandidate', {
    token,
    candidate: validated,
    ttlByStatus,
    iceTtlSeconds: iceTtl,
  });
  return emptyResponse(204, corsOrigin);
}

async function handleRoomSnapshot(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  const token = getAccessToken(request, true);
  const snapshot = await roomAction<{
    status: RoomStatus;
    offer: SessionDescription | null;
    answer: SessionDescription | null;
    updatedAt: number;
    expiresAt: number;
  }>(env, roomCode, 'getRoomSnapshot', { token });
  return jsonResponse(snapshot, 200, corsOrigin);
}

async function handleCandidates(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  const token = getAccessToken(request, true);
  const result = await roomAction<{ items: CandidateRecord[] }>(env, roomCode, 'getCandidates', { token });
  return jsonResponse(
    {
      items: result.items,
      mode: 'full',
      lastSeq: 0,
    },
    200,
    corsOrigin
  );
}

async function handleCloseRoom(
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureMutationHeader(request);
  const token = getAccessToken(request, true);
  const ttlByStatus = getRoomTtlMap(env);
  await roomAction(env, roomCode, 'closeRoom', { token, ttlByStatus });
  return emptyResponse(204, corsOrigin);
}

const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [
  { method: 'POST', pattern: /^\/rooms$/, handler: handleCreateRoom },
  { method: 'GET', pattern: /^\/rooms\/([A-Z0-9]{8})\/public$/, handler: handlePublicLookup },
  { method: 'POST', pattern: /^\/rooms\/([A-Z0-9]{8})\/join$/, handler: handleJoinRoom },
  { method: 'POST', pattern: /^\/rooms\/([A-Z0-9]{8})\/offer$/, handler: handleOffer },
  { method: 'POST', pattern: /^\/rooms\/([A-Z0-9]{8})\/answer$/, handler: handleAnswer },
  { method: 'POST', pattern: /^\/rooms\/([A-Z0-9]{8})\/candidate$/, handler: handleCandidate },
  { method: 'GET', pattern: /^\/rooms\/([A-Z0-9]{8})$/, handler: handleRoomSnapshot },
  { method: 'GET', pattern: /^\/rooms\/([A-Z0-9]{8})\/candidates$/, handler: handleCandidates },
  { method: 'POST', pattern: /^\/rooms\/([A-Z0-9]{8})\/close$/, handler: handleCloseRoom },
];

function matchRoute(method: string, pathname: string) {
  for (const route of routes) {
    if (route.method === method) {
      const match = pathname.match(route.pattern);
      if (match) {
        return { handler: route.handler, params: match.slice(1) };
      }
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        const corsOrigin = resolveCorsOrigin(request, env);
        return optionsResponse(corsOrigin);
      }

      const corsOrigin = resolveCorsOrigin(request, env);
      const url = new URL(request.url);
      const match = matchRoute(request.method.toUpperCase(), url.pathname);
      if (!match) {
        throw new RegistryError(404, 'not_found', 'Not found', false);
      }
      const roomCode = match.params[0] ?? null;
      const response = await match.handler(request, env, roomCode, ctx, corsOrigin);
      return applyCorsHeaders(response, corsOrigin);
    } catch (error) {
      if (error instanceof RegistryError) {
        return applyCorsHeaders(errorResponse(error, resolveCorsOrigin(request, env)), resolveCorsOrigin(request, env));
      }
      return applyCorsHeaders(
        jsonResponse(
          { error: { code: 'internal_error', message: 'Unexpected error', retryable: true } },
          500,
          resolveCorsOrigin(request, env)
        ),
        resolveCorsOrigin(request, env)
      );
    }
  },
};
