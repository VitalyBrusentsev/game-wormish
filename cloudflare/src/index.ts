/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Env {
  REGISTRY_ROOMS: DurableObjectNamespace;
  ROOM_TTL_OPEN?: string;
  ROOM_TTL_JOINED?: string;
  ROOM_TTL_PAIRED?: string;
  ROOM_TTL_CLOSED?: string;
  ICE_TTL?: string;
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT_CREATE: RateLimiter;
  RATE_LIMIT_PUBLIC: RateLimiter;
  RATE_LIMIT_JOIN_IP: RateLimiter;
  RATE_LIMIT_JOIN_ROOM: RateLimiter;
  RATE_LIMIT_POLL_ROOM: RateLimiter;
  RATE_LIMIT_MUTATION_ROOM: RateLimiter;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
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
  open: 180,
  joined: 300,
  paired: 600,
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

function getAccessToken(request: Request, required: true): string;
function getAccessToken(request: Request, required: false): string | null;
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

type TtlConfig = Record<RoomStatus, number>;

interface DurableSuccess<T> {
  status: number;
  data: T;
}

interface DurableErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSec?: number;
}

type DurableEnvelope<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: DurableErrorPayload };

interface CreateRoomPayload {
  type: 'create';
  code: string;
  hostUserName: string;
  joinCode: string;
  ownerToken: string;
  ttlConfig: TtlConfig;
}

interface PublicLookupPayload {
  type: 'public_lookup';
}

interface JoinRoomPayload {
  type: 'join';
  joinCode: string;
  guestUserName: string;
  ttlConfig: TtlConfig;
}

interface OfferPayload {
  type: 'offer';
  token: string;
  description: SessionDescription;
  ttlConfig: TtlConfig;
}

interface AnswerPayload {
  type: 'answer';
  token: string;
  description: SessionDescription;
  ttlConfig: TtlConfig;
}

interface CandidatePayload {
  type: 'candidate';
  token: string;
  candidate: CandidateRecord;
  iceTtlSeconds: number;
}

interface SnapshotPayload {
  type: 'snapshot';
  token: string;
}

interface CandidatesPayload {
  type: 'candidates';
  token: string;
}

interface ClosePayload {
  type: 'close';
  token: string;
  ttlConfig: TtlConfig;
}

type RoomDurableRequest =
  | CreateRoomPayload
  | PublicLookupPayload
  | JoinRoomPayload
  | OfferPayload
  | AnswerPayload
  | CandidatePayload
  | SnapshotPayload
  | CandidatesPayload
  | ClosePayload;

function getRoomTtlConfig(env: Env): TtlConfig {
  return {
    open: getRoomTtl(env, 'open'),
    joined: getRoomTtl(env, 'joined'),
    paired: getRoomTtl(env, 'paired'),
    closed: getRoomTtl(env, 'closed'),
  };
}

function getRoomStub(env: Env, code: string): DurableObjectStub {
  const id = env.REGISTRY_ROOMS.idFromName(code);
  return env.REGISTRY_ROOMS.get(id);
}

async function sendRoomRequest<T>(env: Env, code: string, payload: RoomDurableRequest): Promise<DurableSuccess<T>> {
  const stub = getRoomStub(env, code);
  const response = await stub.fetch('https://registry.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const envelope = (await response.json()) as DurableEnvelope<T>;
  if (!envelope.ok) {
    const error = envelope.error;
    throw new RegistryError(envelope.status, error.code, error.message, error.retryable, error.retryAfterSec);
  }
  return { status: envelope.status, data: envelope.data };
}

function candidateDedupeKey(candidate: CandidateRecord): string {
  return [candidate.candidate, candidate.sdpMid ?? '', candidate.sdpMLineIndex ?? -1].join('::');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function getClientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function enforceWorkerRateLimit(limiter: RateLimiter, request: Request): Promise<void> {
  const { success } = await limiter.limit({ key: `ip:${getClientIp(request)}` });
  if (!success) {
    throw new RegistryError(429, 'rate_limited', 'Too many requests', true);
  }
}

async function handleCreateRoom(
  request: Request,
  env: Env,
  _roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  await enforceWorkerRateLimit(env.RATE_LIMIT_CREATE, request);
  ensureMutationHeader(request);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<{ hostUserName?: unknown }>(rawBody);
  validateUserName(body.hostUserName);
  const ttlConfig = getRoomTtlConfig(env);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRoomCode();
    const joinCode = generateJoinCode();
    const ownerToken = generateToken();
    try {
      const { data } = await sendRoomRequest<{ room: RoomRecord }>(env, code, {
        type: 'create',
        code,
        hostUserName: body.hostUserName,
        joinCode,
        ownerToken,
        ttlConfig,
      });
      return jsonResponse(
        {
          code: data.room.code,
          joinCode: data.room.joinCode,
          ownerToken: data.room.ownerToken,
          expiresAt: data.room.expiresAt,
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
  request: Request,
  env: Env,
  roomCode: string | null,
  _ctx: WorkerExecutionContext,
  corsOrigin: AllowedOrigin
): Promise<Response> {
  if (!roomCode) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  await enforceWorkerRateLimit(env.RATE_LIMIT_PUBLIC, request);
  const { data } = await sendRoomRequest<{ status: RoomStatus; expiresAt: number; hostUserName: string }>(env, roomCode, {
    type: 'public_lookup',
  });
  return jsonResponse(data, 200, corsOrigin);
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
  await enforceWorkerRateLimit(env.RATE_LIMIT_JOIN_IP, request);
  ensureMutationHeader(request);
  const rawBody = await readBodyText(request);
  const body = parseJsonBody<{ joinCode?: unknown; guestUserName?: unknown }>(rawBody);
  validateJoinCode(body.joinCode);
  validateUserName(body.guestUserName);
  const ttlConfig = getRoomTtlConfig(env);
  const { data } = await sendRoomRequest<{ guestToken: string; expiresAt: number }>(env, roomCode, {
    type: 'join',
    joinCode: body.joinCode,
    guestUserName: body.guestUserName,
    ttlConfig,
  });
  return jsonResponse(data, 200, corsOrigin);
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
  const description = validateSdp(body, 'offer');
  const ttlConfig = getRoomTtlConfig(env);
  await sendRoomRequest<null>(env, roomCode, {
    type: 'offer',
    token: token!,
    description,
    ttlConfig,
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
  const description = validateSdp(body, 'answer');
  const ttlConfig = getRoomTtlConfig(env);
  await sendRoomRequest<null>(env, roomCode, {
    type: 'answer',
    token,
    description,
    ttlConfig,
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
  const validated = validateCandidate(body);
  await sendRoomRequest<null>(env, roomCode, {
    type: 'candidate',
    token,
    candidate: validated,
    iceTtlSeconds: getIceTtl(env),
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
  const { data } = await sendRoomRequest<{
    status: RoomStatus;
    offer: SessionDescription | null;
    answer: SessionDescription | null;
    updatedAt: number;
    expiresAt: number;
  }>(env, roomCode, {
    type: 'snapshot',
    token,
  });
  return jsonResponse(data, 200, corsOrigin);
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
  const { data } = await sendRoomRequest<{ items: CandidateRecord[]; mode: 'full'; lastSeq: number }>(env, roomCode, {
    type: 'candidates',
    token,
  });
  return jsonResponse(data, 200, corsOrigin);
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
  const ttlConfig = getRoomTtlConfig(env);
  await sendRoomRequest<null>(env, roomCode, {
    type: 'close',
    token,
    ttlConfig,
  });
  return emptyResponse(204, corsOrigin);
}

interface IceBucket {
  items: CandidateRecord[];
  expiresAt: number;
}

export class RegistryRoomDurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  private json<T>(payload: DurableEnvelope<T>): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  private success<T>(status: number, data: T): Response {
    return this.json({ ok: true, status, data });
  }

  private failure(error: RegistryError): Response {
    const payload: DurableErrorPayload = {
      code: error.code,
      message: error.messageText,
      retryable: error.retryable,
    };
    if (typeof error.retryAfterSec === 'number') {
      payload.retryAfterSec = error.retryAfterSec;
    }
    return this.json({ ok: false, status: error.httpStatus, error: payload });
  }

  private async clearState(): Promise<void> {
    await this.state.storage.delete('room');
    await this.state.storage.delete('ice:host');
    await this.state.storage.delete('ice:guest');
  }

  private async loadRoom(now: number): Promise<RoomRecord | null> {
    const stored = await this.state.storage.get<RoomRecord>('room');
    if (!stored) {
      return null;
    }
    if (stored.expiresAt <= now) {
      await this.clearState();
      return null;
    }
    return stored;
  }

  private async requireRoom(now: number): Promise<RoomRecord> {
    const room = await this.loadRoom(now);
    if (!room) {
      throw new RegistryError(404, 'not_found', 'Room not found', false);
    }
    if (room.status === 'closed') {
      throw new RegistryError(404, 'not_found', 'Room not found', false);
    }
    return room;
  }

  private requireToken(room: RoomRecord, token: string): 'host' | 'guest' {
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

  private async saveRoom(room: RoomRecord): Promise<void> {
    await this.state.storage.put('room', clone(room));
  }

  private iceKey(role: 'host' | 'guest'): string {
    return `ice:${role}`;
  }

  private async readCandidates(role: 'host' | 'guest', now: number): Promise<CandidateRecord[]> {
    const bucket = await this.state.storage.get<IceBucket>(this.iceKey(role));
    if (!bucket) {
      return [];
    }
    if (bucket.expiresAt <= now) {
      await this.state.storage.delete(this.iceKey(role));
      return [];
    }
    return bucket.items.map((item) => clone(item));
  }

  private async appendCandidate(
    role: 'host' | 'guest',
    candidate: CandidateRecord,
    iceTtlSeconds: number,
    now: number
  ): Promise<void> {
    const key = this.iceKey(role);
    const bucket = await this.state.storage.get<IceBucket>(key);
    let items: CandidateRecord[] = [];
    if (bucket && bucket.expiresAt > now) {
      items = bucket.items.slice();
    }
    const dedupe = new Map(items.map((item) => [candidateDedupeKey(item), item] as const));
    const candidateKey = candidateDedupeKey(candidate);
    if (!dedupe.has(candidateKey)) {
      if (items.length >= MAX_CANDIDATES_PER_PEER) {
        throw new RegistryError(409, 'too_many_candidates', 'Candidate limit reached', true);
      }
      items.push(clone(candidate));
    }
    const ttlSeconds = Math.max(1, Math.floor(iceTtlSeconds));
    await this.state.storage.put(key, {
      items,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  private roomTtlForStatus(room: RoomRecord, ttlConfig: TtlConfig): number {
    return ttlConfig[room.status];
  }

  private async enforceRateLimit(limiter: RateLimiter, key: string): Promise<void> {
    const result = await limiter.limit({ key });
    if (!result.success) {
      throw new RegistryError(429, 'rate_limited', 'Too many requests', true);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const payload = (await request.json()) as Partial<RoomDurableRequest>;
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
        throw new RegistryError(400, 'bad_request', 'Invalid request payload', false);
      }
      const now = Date.now();
      switch (payload.type) {
        case 'create': {
          const createPayload = payload as CreateRoomPayload;
          const existing = await this.loadRoom(now);
          if (existing) {
            throw new RegistryError(409, 'room_exists', 'Room already exists', true);
          }
          const ttl = Math.max(1, Math.floor(createPayload.ttlConfig.open));
          const room: RoomRecord = {
            code: createPayload.code,
            hostUserName: createPayload.hostUserName,
            joinCode: createPayload.joinCode,
            ownerToken: createPayload.ownerToken,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + ttl * 1000,
          };
          await this.state.storage.put('room', clone(room));
          await this.state.storage.delete(this.iceKey('host'));
          await this.state.storage.delete(this.iceKey('guest'));
          return this.success(201, { room: clone(room) });
        }
        case 'public_lookup': {
          const room = await this.loadRoom(now);
          if (!room || room.status !== 'open') {
            throw new RegistryError(404, 'not_found', 'Room not found', false);
          }
          return this.success(200, {
            status: room.status,
            expiresAt: room.expiresAt,
            hostUserName: room.hostUserName,
          });
        }
        case 'join': {
          const joinPayload = payload as JoinRoomPayload;
          const room = await this.requireRoom(now);
          await this.enforceRateLimit(this.env.RATE_LIMIT_JOIN_ROOM, `room:${room.code}:join`);
          if (room.status !== 'open') {
            throw new RegistryError(409, 'not_open', 'Room is not open for joining', false);
          }
          if (!room.joinCode || room.joinCode !== joinPayload.joinCode) {
            throw new RegistryError(403, 'bad_join_code', 'Join code is invalid', false);
          }
          const guestToken = generateToken();
          room.guestUserName = joinPayload.guestUserName;
          room.guestToken = guestToken;
          delete room.joinCode;
          room.status = 'joined';
          room.updatedAt = now;
          const ttl = Math.max(1, Math.floor(joinPayload.ttlConfig.joined));
          room.expiresAt = now + ttl * 1000;
          await this.saveRoom(room);
          await this.state.storage.delete(this.iceKey('guest'));
          return this.success(200, { guestToken, expiresAt: room.expiresAt });
        }
        case 'offer': {
          const offerPayload = payload as OfferPayload;
          const room = await this.requireRoom(now);
          const role = this.requireToken(room, offerPayload.token);
          await this.enforceRateLimit(this.env.RATE_LIMIT_MUTATION_ROOM, `room:${room.code}:mutation`);
          if (role !== 'host') {
            throw new RegistryError(403, 'forbidden', 'Only the host can set the offer', false);
          }
          if (room.status === 'paired' || room.status === 'closed') {
            throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
          }
          room.offer = offerPayload.description;
          room.updatedAt = now;
          const ttl = Math.max(1, Math.floor(this.roomTtlForStatus(room, offerPayload.ttlConfig)));
          room.expiresAt = now + ttl * 1000;
          await this.saveRoom(room);
          return this.success(204, null);
        }
        case 'answer': {
          const answerPayload = payload as AnswerPayload;
          const room = await this.requireRoom(now);
          const role = this.requireToken(room, answerPayload.token);
          await this.enforceRateLimit(this.env.RATE_LIMIT_MUTATION_ROOM, `room:${room.code}:mutation`);
          if (role !== 'guest') {
            throw new RegistryError(403, 'forbidden', 'Only the guest can set the answer', false);
          }
          if (!room.offer) {
            throw new RegistryError(409, 'no_offer', 'Offer must be set before answer', false);
          }
          if (room.status === 'paired' || room.status === 'closed') {
            throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
          }
          room.answer = answerPayload.description;
          room.status = 'paired';
          room.updatedAt = now;
          const ttl = Math.max(1, Math.floor(answerPayload.ttlConfig.paired));
          room.expiresAt = now + ttl * 1000;
          await this.saveRoom(room);
          return this.success(204, null);
        }
        case 'candidate': {
          const candidatePayload = payload as CandidatePayload;
          const room = await this.requireRoom(now);
          const role = this.requireToken(room, candidatePayload.token);
          await this.enforceRateLimit(this.env.RATE_LIMIT_MUTATION_ROOM, `room:${room.code}:mutation`);
          if (room.status === 'closed') {
            throw new RegistryError(409, 'not_open', 'Room is closed', false);
          }
          await this.appendCandidate(role, candidatePayload.candidate, candidatePayload.iceTtlSeconds, now);
          return this.success(204, null);
        }
        case 'snapshot': {
          const snapshotPayload = payload as SnapshotPayload;
          const room = await this.requireRoom(now);
          this.requireToken(room, snapshotPayload.token);
          await this.enforceRateLimit(this.env.RATE_LIMIT_POLL_ROOM, `room:${room.code}:poll`);
          return this.success(200, {
            status: room.status,
            offer: room.offer ? clone(room.offer) : null,
            answer: room.answer ? clone(room.answer) : null,
            updatedAt: room.updatedAt,
            expiresAt: room.expiresAt,
          });
        }
        case 'candidates': {
          const candidatesPayload = payload as CandidatesPayload;
          const room = await this.requireRoom(now);
          const role = this.requireToken(room, candidatesPayload.token);
          const otherRole = role === 'host' ? 'guest' : 'host';
          const items = await this.readCandidates(otherRole, now);
          return this.success(200, { items, mode: 'full', lastSeq: 0 });
        }
        case 'close': {
          const closePayload = payload as ClosePayload;
          const room = await this.requireRoom(now);
          const role = this.requireToken(room, closePayload.token);
          if (role !== 'host') {
            throw new RegistryError(403, 'forbidden', 'Only the host can close the room', false);
          }
          room.status = 'closed';
          room.updatedAt = now;
          const ttl = Math.max(1, Math.floor(closePayload.ttlConfig.closed));
          room.expiresAt = now + ttl * 1000;
          await this.saveRoom(room);
          return this.success(204, null);
        }
        default:
          throw new RegistryError(400, 'bad_request', 'Unknown request type', false);
      }
    } catch (error) {
      if (error instanceof RegistryError) {
        return this.failure(error);
      }
      return this.failure(new RegistryError(500, 'internal_error', 'Unexpected error', true));
    }
  }
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
