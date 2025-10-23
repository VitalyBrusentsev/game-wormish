/* eslint-disable @typescript-eslint/no-explicit-any */
export interface KVNamespaceGetOptions<T> {
  type?: 'text' | 'json' | 'arrayBuffer';
  cacheTtl?: number;
}

export interface KVNamespacePutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: Record<string, unknown>;
}

export interface KVNamespace {
  get(key: string, options?: KVNamespaceGetOptions<string>): Promise<string | null>;
  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  REGISTRY_KV: KVNamespace;
  ROOM_TTL_OPEN?: string;
  ROOM_TTL_JOINED?: string;
  ROOM_TTL_PAIRED?: string;
  ROOM_TTL_CLOSED?: string;
  ICE_TTL?: string;
  ALLOWED_ORIGINS?: string;
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

function getRoomKey(code: string): string {
  return `room:${code}`;
}

function getIceKey(code: string, role: 'host' | 'guest'): string {
  return `ice:${code}:${role}`;
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

async function loadRoom(env: Env, code: string): Promise<RoomRecord | null> {
  const raw = await env.REGISTRY_KV.get(getRoomKey(code));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as RoomRecord;
  } catch (error) {
    return null;
  }
}

async function saveRoom(env: Env, room: RoomRecord): Promise<void> {
  const ttl = getRoomTtl(env, room.status);
  const expiresAt = Date.now() + ttl * 1000;
  room.expiresAt = expiresAt;
  await env.REGISTRY_KV.put(getRoomKey(room.code), JSON.stringify(room), {
    expirationTtl: ttl,
  });
}

function candidateDedupeKey(candidate: CandidateRecord): string {
  return [candidate.candidate, candidate.sdpMid ?? '', candidate.sdpMLineIndex ?? -1].join('::');
}

async function appendCandidate(env: Env, code: string, role: 'host' | 'guest', candidate: CandidateRecord): Promise<void> {
  const key = getIceKey(code, role);
  const raw = await env.REGISTRY_KV.get(key);
  const existing: CandidateRecord[] = raw ? (JSON.parse(raw) as CandidateRecord[]) : [];
  const dedupe = new Map(existing.map((item) => [candidateDedupeKey(item), item] as const));
  const candidateKey = candidateDedupeKey(candidate);
  if (!dedupe.has(candidateKey)) {
    if (existing.length >= MAX_CANDIDATES_PER_PEER) {
      throw new RegistryError(409, 'too_many_candidates', 'Candidate limit reached', true);
    }
    existing.push(candidate);
  }
  const ttl = getIceTtl(env);
  await env.REGISTRY_KV.put(key, JSON.stringify(existing), { expirationTtl: ttl });
}

async function readCandidates(env: Env, code: string, role: 'host' | 'guest'): Promise<CandidateRecord[]> {
  const raw = await env.REGISTRY_KV.get(getIceKey(code, role));
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as CandidateRecord[];
  } catch (error) {
    return [];
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

async function ensureUniqueRoomCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRoomCode();
    const existing = await env.REGISTRY_KV.get(getRoomKey(code));
    if (!existing) {
      return code;
    }
  }
  throw new RegistryError(503, 'retry', 'Unable to allocate room code', true, 1);
}

function ensureRoomAccessible(room: RoomRecord): void {
  if (room.status === 'closed') {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
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

  const code = await ensureUniqueRoomCode(env);
  const joinCode = generateJoinCode();
  const ownerToken = generateToken();
  const now = Date.now();
  const room: RoomRecord = {
    code,
    hostUserName: body.hostUserName,
    joinCode,
    ownerToken,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + getRoomTtl(env, 'open') * 1000,
  };
  await saveRoom(env, room);
  const responseBody = {
    code,
    joinCode,
    ownerToken,
    expiresAt: room.expiresAt,
  };
  return jsonResponse(responseBody, 201, corsOrigin);
}

async function requireRoom(env: Env, code: string): Promise<RoomRecord> {
  const room = await loadRoom(env, code);
  if (!room) {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  ensureRoomAccessible(room);
  return room;
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
  const room = await loadRoom(env, roomCode);
  if (!room || room.status !== 'open') {
    throw new RegistryError(404, 'not_found', 'Room not found', false);
  }
  return jsonResponse(
    {
      status: room.status,
      expiresAt: room.expiresAt,
      hostUserName: room.hostUserName,
    },
    200,
    corsOrigin
  );
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
  const room = await requireRoom(env, roomCode);
  if (room.status !== 'open') {
    throw new RegistryError(409, 'not_open', 'Room is not open for joining', false);
  }
  if (!room.joinCode || room.joinCode !== body.joinCode) {
    throw new RegistryError(403, 'bad_join_code', 'Join code is invalid', false);
  }
  const now = Date.now();
  const guestToken = generateToken();
  room.guestUserName = body.guestUserName;
  room.guestToken = guestToken;
  delete room.joinCode;
  room.status = 'joined';
  room.updatedAt = now;
  await saveRoom(env, room);
  return jsonResponse({ guestToken, expiresAt: room.expiresAt }, 200, corsOrigin);
}

function requireToken(room: RoomRecord, token: string | null): { role: 'host' | 'guest' } {
  if (!token) {
    throw new RegistryError(403, 'forbidden', 'Missing access token', false);
  }
  if (token === room.ownerToken) {
    return { role: 'host' };
  }
  if (room.guestToken && token === room.guestToken) {
    return { role: 'guest' };
  }
  throw new RegistryError(403, 'forbidden', 'Invalid access token', false);
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
  const room = await requireRoom(env, roomCode);
  const { role } = requireToken(room, token);
  if (role !== 'host') {
    throw new RegistryError(403, 'forbidden', 'Only the host can set the offer', false);
  }
  if (room.status === 'paired' || room.status === 'closed') {
    throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
  }
  room.offer = validateSdp(body, 'offer');
  room.updatedAt = Date.now();
  await saveRoom(env, room);
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
  const room = await requireRoom(env, roomCode);
  const { role } = requireToken(room, token);
  if (role !== 'guest') {
    throw new RegistryError(403, 'forbidden', 'Only the guest can set the answer', false);
  }
  if (!room.offer) {
    throw new RegistryError(409, 'no_offer', 'Offer must be set before answer', false);
  }
  if (room.status === 'paired' || room.status === 'closed') {
    throw new RegistryError(409, 'already_paired', 'Room already paired or closed', false);
  }
  room.answer = validateSdp(body, 'answer');
  room.status = 'paired';
  room.updatedAt = Date.now();
  await saveRoom(env, room);
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
  const room = await requireRoom(env, roomCode);
  const { role } = requireToken(room, token);
  if (room.status === 'closed') {
    throw new RegistryError(409, 'not_open', 'Room is closed', false);
  }
  const validated = validateCandidate(body);
  await appendCandidate(env, room.code, role, validated);
  room.updatedAt = Date.now();
  await saveRoom(env, room);
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
  const room = await requireRoom(env, roomCode);
  requireToken(room, token);
  return jsonResponse(
    {
      status: room.status,
      offer: room.offer ?? null,
      answer: room.answer ?? null,
      updatedAt: room.updatedAt,
      expiresAt: room.expiresAt,
    },
    200,
    corsOrigin
  );
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
  const room = await requireRoom(env, roomCode);
  const { role } = requireToken(room, token);
  const otherRole = role === 'host' ? 'guest' : 'host';
  const items = await readCandidates(env, room.code, otherRole);
  return jsonResponse(
    {
      items,
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
  const room = await requireRoom(env, roomCode);
  const { role } = requireToken(room, token);
  if (role !== 'host') {
    throw new RegistryError(403, 'forbidden', 'Only the host can close the room', false);
  }
  room.status = 'closed';
  room.updatedAt = Date.now();
  await saveRoom(env, room);
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
