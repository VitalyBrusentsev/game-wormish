# Cloudflare “Registry” API — Functional Requirements

## Goal
A minimal, secure signaling backend for 2‑player WebRTC rooms. Stores SDP offers/answers and ICE candidates with short TTLs; never carries game data.

This proposal relies on a **human‑friendly, short‑lived room & join codes**. The host creates a room (with very short TTL, about 30-60 seconds, unless it's joined) with unique room code, which generates a unique join code. The host shares the room code and the join code out‑of‑band (chat/voice). The guest redeems the join code to obtain an access / exchange capability, and both peers exchange their ICE candidates to establish the WebRTC connection for actual network gameplay data exchange.

## Platform & Bindings
- **Cloudflare Worker** (HTTP JSON API).
- **KV Namespace**: `REGISTRY_KV`
- **Cloudflare WAF/Rate Limiting**: blanket + per‑IP on sensitive endpoints.
- Optional: **Turnstile** (captcha) or identity JWT on room creation.


## Threat Model (Summary)

- **Guessing & abuse:** Mitigated via unguessable room codes, short‑lived join codes and tokens, strict payload caps, per‑state TTLs, and rate limits.

## Data Model (KV)

- `room:<code>` → Room JSON (below)
- `ice:<code>:host` → JSON array of RTCIceCandidateInit (bounded, deduped)
- `ice:<code>:guest` → JSON array of RTCIceCandidateInit (bounded, deduped)

**Room JSON**
```json
{
"code": "ABCD12",
"hostUserName": "Alice1996",
"guestUserName": "Bob1997",                   // optional, set on join
"joinCode": "123456",                         // deleted on successful join
"ownerToken": "<opaque random>",              // host capability (room-scoped)
"guestToken": "<opaque random>",              // guest capability (room-scoped; minted on join)
"offer":{ "type": "offer","sdp": "..." },     // UTF‑8 SDP (raw)
"answer": { "type": "answer", "sdp": "..." }, // UTF‑8 SDP (raw)
"status": "open|joined|paired|closed",
"createdAt": 1739999999999,
"updatedAt": 1739999999999,
"expiresAt": 1740001799999
}
```

## TTLs (Per‑State, Aligned)

- `ROOM_TTL_OPEN` = **60s**
- `ROOM_TTL_JOINED` = **180s**
- `ROOM_TTL_PAIRED` = **300s**
- `ROOM_TTL_CLOSED` = **15s** (expire ASAP)
- `ICE_TTL` = **600s** (10 minutes) for both `ice:<code>:(host|guest)`

**Rules**
- Valid mutations “touch” the room TTL for the **current state**.
- State transitions (`open→joined→paired→closed`) set the **state‑specific** TTL.
- All timestamps are **server‑derived** and advisory for clients (display / retry cadence only).


## Security & Access

- **Room codes**: base36, 6–8 chars, no “list rooms” API. 200/404 behavior avoids oracle leakage.
- **Join codes**: 6 digits, **single‑use**, deleted on successful join.
- **Access tokens**: opaque, ≥128‑bit entropy, **room‑scoped**, **short‑lived** (no longer than room TTL).
- **Header**: all sensitive reads/writes require `X-Access-Token`.
- **CORS**: locked to `ALLOWED_ORIGINS`. Later CSRF hardening via custom header requirement (see below).
- **No logging of secrets or SDP/candidate bodies**; log sizes/hashes only.

## Validation & Limits (Server‑Side)

- **SDP**: UTF‑8 text, presence/type, length ≤ **20 KB**.
- **ICE candidate**: `{ candidate, sdpMid?, sdpMLineIndex? }`, length ≤ **1 KB**.
- **Candidate cap**: ≤ **40** per peer
- **Request body**: ≤ **64 KB** total per request.
- **Dedupe key**: `(candidate, sdpMid, sdpMLineIndex)`.
- **State constraints**: only one `answer`; after `paired`, new `offer/answer` → `409` (candidates still accepted until expiry).

## Rate Limits (Initial)

- **Create**: ≤ **5 / min / IP** (token bucket).
- **Join attempts**: ≤ **10 / min / IP** and ≤ **10 / min / room**.
- **Per‑room mutations** (offer/answer/candidate): ≤ **200 / 5 min** (combined roles).
- Friendly `429` JSON with `retryAfterSec` for UI backoff.


## User Flow (Host + Guest)

1. **Create Room**
 - `POST /rooms` `{ "name": "Alice1996" }` → `201`
 ```json
 { "code": "ABCD12", "joinCode": "123456", "ownerToken": "<...>", "expiresAt": 1740001799999 }
 ```

2. **Public lookup (guest)**
 - `GET /rooms/:code/public` → `200` if **open**, otherwise `404`
 ```json
 { "status": "open", "expiresAt": 1740001799999, "hostUserName": "Alice1996" }
 ```

3. **Guest sees the expected hostUserName (e.g., "Alice1996"), enters and redeems joinCode** 
 - `POST /rooms/:code/join` `{ "joinCode": "123456", "name": "Bob1997" }` → `200`
 ```json
 { "guestToken": "<...>", "expiresAt": 1740001799999 }
 ```

4. **Offer/Answer**
 - Host `POST /rooms/:code/offer` (204)
 - Guest `POST /rooms/:code/answer` (204; sets `status:"paired"`)

5. **ICE exchange**
 - Both sides `POST /rooms/:code/candidate` (204; deduped; bounded list)
 - Both sides `GET /rooms/:code/candidates` (see API)

6. **Close (optional)**
 - Host `POST /rooms/:code/close` (204; sets `status:"closed"`, short TTL)

## REST API

> **Notes:**
> - All responses are JSON unless `204`.
> - All server times are epoch ms.
> - Optional “escape hatches” are accepted now but may be ignored by MVP and will be honored in future backend improvements.
> - **Do not** expose storage backend in errors or payloads.

### 1) Create Room
`POST /rooms`
- **Headers**: (optional) Turnstile/JWT for abuse control
- **Body**: `{ "name": "<hostUserName>" }`
- **201 Created**
  ```json
  { "code": "ABCD12", "ownerToken": "<...>", "joinCode": "123456", "expiresAt": 1740001799999 }
  ```
- **Errors**: `429`, `400/401` (Turnstile/JWT).

### 2) Public Room Info
`GET /rooms/:code/public`
- **200 OK** *(only when status=`open`)*
  ```json
  { "status": "open", "expiresAt": 1740001799999, "hostUserName": "Alice1996" }
  ```
- **404 Not Found** *(room missing/expired/not open)*

### 3) Redeem Join Code → Guest Token
`POST /rooms/:code/join`
- **Body**: `{ "joinCode": "123456", "name": "Bob1997" }`
- **200 OK**
  ```json
  { "guestToken": "<...>", "expiresAt": 1740001799999 }
  ```
- **Errors**: 
  - `404` (missing/expired), 
  - `409` (already paired / code consumed), 
  - `400` (bad code), 
  - `429` (rate limited).

### 4) Put Offer (Host)
`POST /rooms/:code/offer`
- **Headers**: `X-Access-Token: <ownerToken>`
- **Body**: `{ "type": "offer", "sdp": "<raw UTF-8 SDP>" }`
- **204 No Content**
- **Errors**: 
  - `403` (bad/missing token), 
  - `404` (room missing/expired), 
  - `409` (already paired or conflicting state).

### 5) Put Answer (Guest)
`POST /rooms/:code/answer`
- **Headers**: `X-Access-Token: <guestToken>`
- **Body**: `{ "type": "answer", "sdp": "<raw UTF-8 SDP>" }`
- **204 No Content** *(also sets `status:"paired"`)*
- **Errors**: as above; plus `409` if no prior offer.

### 6) Append ICE Candidate (Both)
`POST /rooms/:code/candidate`
**Headers**:
- `X-Access-Token: <ownerToken|guestToken>` *(required)*
- `Idempotency-Key: <uuid>` *(optional; MVP may ignore)*
- **Body**:
  ```json
  { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 }
  ```
- **204 No Content**
- **Errors**: `403`, `404`, `413` (body too large), `400` (bad fields).

### 7) Fetch Room Snapshot (Poll)
`GET /rooms/:code`
- **Headers**: `X-Access-Token: <ownerToken|guestToken>`
- **Query (optional)**:
  - `wait=<seconds>` *(≤25; MVP may ignore and return immediately)*
  - `sinceVersion=<n>` *(MVP may ignore)*
- **200 OK**
  ```json
  {
  "status": "open|joined|paired|closed",
  "offer":{ "type": "offer","sdp": "..." } | null,
  "answer": { "type": "answer", "sdp": "..." } | null,
  "updatedAt": 1739999999999,
  "expiresAt": 1740001799999
  }
  ```
- **Headers (optional, future)**: `ETag: "<version-hash>"`
- **304 Not Modified** *(only when `If-None-Match` honored by future backend)*
- **404 Not Found** *(expired/missing/closed and pruned)*

### 8) Drain ICE Candidates (Full‑Set in MVP)
`GET /rooms/:code/candidates`
- **Headers**: `X-Access-Token: <ownerToken|guestToken>`
- **Query (optional)**: `since=<seq>` *(MVP ignores and returns full set)*
- **200 OK**
  ```json
  {
  "items": [ { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } , ... ],
  "mode": "full",// MVP: always "full"
  "lastSeq": 0 // MVP: 0 or omitted (reserved for future delta mode)
  }
  ```
- **Semantics (MVP):** returns the **current complete set** of the *other side’s* candidates, **oldest→newest**.
- **Client guidance:** keep a local set keyed by `(candidate, sdpMid, sdpMLineIndex)`; apply set‑difference; tolerate duplicates.

**Future compatibility:** when `since` is provided, backend may return only deltas with `"mode":"delta"` and real `lastSeq`—without breaking old clients.

### 9) Close Room (Optional)
`POST /rooms/:code/close`
- **Headers**: `X-Access-Token: <ownerToken>`
- **204 No Content** *(sets `status:"closed"`, shrinks TTL to `ROOM_TTL_CLOSED`)*
- **Errors**: `403`, `404`.

## Error Schema (Stable Envelope)

Errors use a compact, branchable structure:

```json
{ "error": { "code": "already_paired", "message": "Room already paired", "retryable": false } }
```

Common `code` values: `bad_join_code`, `not_open`, `already_paired`, `no_offer`, `rate_limited`, `forbidden`, `not_found`, `body_too_large`, `bad_candidate`, `bad_sdp`.

## CORS & CSRF

- Allow only `ALLOWED_ORIGINS`.
- Require `X-Access-Token`
- Future improvement: Require a non-simple custom header on mutations, e.g. `X-Registry-Intent: mutate` (forces preflight).
- Never echo sensitive headers in error bodies.
- `Access-Control-Max-Age` may be set to reduce preflight latency.

## Observability

- **Logs**: `event`, `code`, `ipHash`, `status`, `bytes`, `latencyMs`. No SDP/candidate/token contents.
- **Metrics**: counters for creates, joins, offers, answers, ice_appends, fetches, closes, rejects, rate_limits. Optional histograms (payload sizes, time-to-join, time-to-pair).

## Config (Env)

- `ROOM_TTL_OPEN=60`
- `ROOM_TTL_JOINED=180`
- `ROOM_TTL_PAIRED=300`
- `ROOM_TTL_CLOSED=15`
- `ICE_TTL=600`
- `ALLOWED_ORIGINS`
- `MAX_ROOM_WRITES_PER_5M=200`
- (Optional) `TURNSTILE_SECRET`

## Dev & Test

- Local dev: `wrangler dev` with KV binding.
- Happy path: Create → Join → Offer/Answer → ICE exchange → DataChannel open → Close.
- Same‑machine test: two tabs/windows; expect host candidates; STUN/TURN not required.

## Non‑Goals

- No public matchmaking/presence.
- No TURN/STUN provisioning (clients supply ICE).
- No game data relaying.
- No server‑mediated app HMAC handshake (not effective against abusive but legitimate peers).

## Minimal Client Contract (Reference)

- JSON everywhere; `Content-Type: application/json`.
- Mutations/sensitive reads require `X-Access-Token`
- Guest must redeem `joinCode` before posting `/answer` or `/candidate`.
- Stop polling Registry after DataChannel `open` (keep a Kick UI to close the peer if needed).
- Implement input validation, backpressure (`bufferedAmount` guard), and per‑connection rate/size caps client‑side.

## Future Backwards‑Compatible Evolution (improving concurrency handling and data consistency)

- Introduce Durable Objects for exclusive access to room data
- Start honoring `If-None-Match`/`ETag` and `?wait/sinceVersion` on `/rooms/:code` (long‑poll).
- Start honoring `Idempotency-Key` on candidate appends.
- Add `"mode":"delta"` + `lastSeq` when `?since` is provided on `/candidates`.
- Keep endpoints, status codes, and field names unchanged. Old clients continue to work unmodified.
