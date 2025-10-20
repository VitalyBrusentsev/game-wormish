# Cloudflare “Registry” API — Functional Requirements

## Goal
A minimal, secure signaling backend for 2-player WebRTC rooms. Stores SDP offers/answers and ICE candidates with short TTLs; never carries game data.

---

## Platform & Bindings
- **Cloudflare Worker** (HTTP JSON API).
- **KV Namespace**: `REGISTRY_KV`  
  - Keys auto-expire via **per-key TTL**.
- Optional:
  - **Turnstile** (captcha) for room creation.
  - **Ratelimits** via Cloudflare WAF rules.

---

## Data Model (KV)
- `room:<code>` → JSON  
  ```json
  {
    "code": "ABCD12",
    "writeToken": "<opaque random>",
    "offer": { "type":"offer","sdp":"..." },         // optional
    "answer": { "type":"answer","sdp":"..." },       // optional
    "createdAt": 1739999999999,
    "expiresAt": 1740001799999,
    "status": "open|paired|closed"
  }
  ```
- `ice:<code>:<peer>` → JSON array of RTCIceCandidateInit  
  Example key: `ice:ABCD12:host` or `ice:ABCD12:guest`.

**TTL defaults**
- Rooms: **30 minutes** (configurable).
- ICE buckets: **15 minutes** (configurable).

---

## Security & Access
- **Room codes**: 6–8 char base36 (or noun-adjective-animal words). Not enumerable.
- **Write token**: Required for any mutating call (header `X-Write-Token`).
- **CORS**: Restrict to allowed origins (env var `ALLOWED_ORIGINS`).
- **No listing endpoints**; access by exact code only.
- **Size limits**: body ≤ 64 KB; reject oversize (413).
- **Input validation**: Only accept well-formed SDP/candidate JSON.
- **Abuse controls**:
  - Per-IP create limit (e.g., **5/min**).
  - Per-room write cap (e.g., **200 writes/5 min**).
  - Optional **Turnstile** on `POST /rooms`.

---

## REST API

### 1) Create Room
`POST /rooms`
- **Headers**: `CF-Connecting-IP` (implicit), optional Turnstile.
- **Body** (optional): `{ "ttlSeconds": 1800 }`
- **Responses**
  - `201` `{ "code","writeToken","expiresAt" }`
  - `429` if rate limited
  - `400/401` on Turnstile failure
- **Effects**: Create `room:<code>` with TTL; `status:"open"`.

### 2) Put Offer
`POST /rooms/:code/offer`
- **Headers**: `X-Write-Token`
- **Body**: `{ "sdp": "<base64 or raw SDP string>", "type": "offer" }`
- **Responses**
  - `204` no content
  - `403` bad/missing token
  - `404` room not found
  - `409` if offer already set and room not reset
- **Effect**: Merge `offer`; refresh TTL.

### 3) Put Answer
`POST /rooms/:code/answer`
- **Headers**: `X-Write-Token`
- **Body**: `{ "sdp": "...", "type": "answer" }`
- **Responses**: same as **Put Offer**
- **Effect**: Merge `answer`; set `status:"paired"`; refresh TTL.

### 4) Append ICE Candidate
`POST /rooms/:code/candidate`
- **Headers**: `X-Write-Token`
- **Body** (single candidate):  
  `{ "candidate":"...", "sdpMid":"data", "sdpMLineIndex":0 }`
- **Responses**
  - `204`
  - `403/404`
- **Effect**: Push to `ice:<code>:<derivedPeer>`; ICE TTL applies.

> **Peer attribution**: derive `"host"` vs `"guest"` from first writer for this token, or require client to send `peer:"host"|"guest"`.

### 5) Fetch Room Snapshot (poll)
`GET /rooms/:code`
- **Query**: optional `since=<msEpoch>` to reduce payload.
- **Response `200`**
  ```json
  {
    "offer": {...} | null,
    "answer": {...} | null,
    "status": "open|paired|closed",
    "expiresAt": 1740001799999,
    "updatedAt": 1739999999999
  }
  ```
- **404** if expired/missing.

### 6) Drain ICE (batch read)
`GET /rooms/:code/candidates?peer=host|guest&after=<cursor>`
- **Response `200`**
  ```json
  { "items":[{...},{...}], "next": "<cursor or null>" }
  ```
- **Notes**: Simple cursor = last index; server is free to GC.

### 7) Close Room (optional)
`POST /rooms/:code/close`
- **Headers**: `X-Write-Token`
- **Response**: `204` or `403/404`
- **Effect**: Set `status:"closed"`, shorten TTL to e.g. 60s.

---

## Behaviors & Rules
- **Idempotency**: Reposting same SDP is allowed; replace value.
- **TTL touch**: Any mutating call extends room TTL (configurable).
- **Two-peer constraint**: First writer becomes `host`; first `answer` sets `guest`; reject a third distinct writer (`409`).
- **No history** for SDP; ICE is append-only with natural expiry.
- **Privacy**: Store only SDP/ICE + minimal metadata. No IPs.

---

## Errors (JSON)
```json
{ "error": "BadRequest", "message": "invalid SDP" }
```
- `400` BadRequest (validation)
- `401` Unauthorized (Turnstile)
- `403` Forbidden (token)
- `404` NotFound (room/expired)
- `409` Conflict (capacity/duplicate peer)
- `413` PayloadTooLarge
- `429` TooManyRequests
- `500` InternalError (opaque)

---

## Config (Env)
- `ROOM_TTL_SEC` (default 1800)
- `ICE_TTL_SEC` (default 900)
- `ALLOWED_ORIGINS` (CSV)
- `TURNSTILE_SECRET` (optional)
- `MAX_ROOM_WRITES_PER_5M` (e.g., 200)

---

## Observability
- **Logs**: `event`, `code`, `ipHash`, `status`, `bytes`, `latencyMs`.
- **Metrics** (Durable Objects not required): counters for creates, joins, offers, answers, ice_appends, fetches, closes, rejects, rate_limits.

---

## Dev & Test Notes
- **Local**: `wrangler dev` with KV bindings.
- **Happy path e2e**: Create → Offer → Poll from guest → Answer → Exchange ICE → DataChannel open → Close.
- **Same-machine test**: two tabs; should connect via host candidates (no TURN).

---

## Non-Goals
- No matchmaking lists, presence, or user accounts.
- No TURN/STUN provisioning; clients supply ICE servers.
- No game data forwarding.

---

## Minimal Client Contract (reference)
- All requests/returns **JSON**; UTF-8; `Content-Type: application/json`.
- Include `X-Write-Token` for **POST** to room resources.
- Poll `GET /rooms/:code` and `GET /rooms/:code/candidates` until connected; stop after DataChannel `open`.
