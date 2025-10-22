# Cloudflare “Registry” API — Functional Requirements

## Goal
A minimal, secure signaling backend for 2‑player WebRTC rooms. Stores SDP offers/answers and ICE candidates with short TTLs; never carries game data.

This proposal relies on a **human‑friendly, short‑lived room & join codes**. The host creates a room (with very short TTL, about 30-60 seconds, unless it's joined) with unique room code, which generates a unique join code. The host shares the room code and the join code out‑of‑band (chat/voice). The guest redeems the join code to obtain a scoped write capability, and both peers exchange their ICE candidates to establish the WebRTC connection for actual network gameplay data exchange.

## Platform & Bindings
- **Cloudflare Worker** (HTTP JSON API).
- **KV Namespace**: `REGISTRY_KV`
  - Keys auto-expire via **per-key TTL**.
  - **Cloudflare WAF/rate limiting**: blanket rate limits on sensitive endpoints, and additional IP address based rate limits, to prevent abuse / DoS.
- Optional:
  - **Turnstile** (captcha) on room creation, or requesting a trusted identity JWT (Google?)
  - **Durable Object** (optional) for strict room serialization.


## Threat Model Summary
- **Registry abuse**: mitigated via unguessable room codes, short TTLs, strict payload caps, scoped access capabilities, and rate limits.
- **Rando guessing**: short‑lived join code + rate limits keep risk low.

## Data Model (KV)

### Room record
Key: `room:<code>` → JSON
```javascript
{
  "code": "ABCD12",
  "joinCode": "123456",                  // exchanged out of band
  "hostName": "Alice1996",                // provided by the host UI upon creation
  "guestName": "Bob1993",                 // optional, provided by the guest UI upon joining
  "ownerToken": "<opaque random>",        // access cap for host
  "guestToken": "<opaque random>",        // access cap for guest
  "offer": { "type": "offer", "sdp": "..." },    // optional, updated by host for SDP exchange
  "answer": { "type": "answer", "sdp": "..." },  // optional, updated by guest for SDP exchange
  "createdAt": 1739999999999,
  "updatedAt": 1739999999999,
  "expiresAt": 1740001799999,
  "status": "open|joined|paired|closed"
}
```

### ICE buckets
  - Key: `ice:<code>:host` → JSON array of RTCIceCandidateInit
  - Key: `ice:<code>:guest` → same

### TTL defaults
- Room key: 
  - Open: **30-60 seconds** (configurable),
  - Joined: **3 minutes**
  - Paired: **5 minutes**
  - Closed: TTL is set to expire ASAP.
- ICE buckets: **10 minutes**.


## Security & Access
- **Room codes**: 6–8 chars base36. Not enumerable; no "list rooms" API. Knowing a room code only gives public information about an open room, you need to know the join code at the right time window for the rest of the exchange.
- Join Codes: 6 digits. Immediately invalidated (erased) upon successful join.
- **Access tokens**: crypto random, at least 128 bits entropy, **room‑scoped**, **short‑lived** (≤ room TTL). Required for all writes (and sensitive reads) via header `X-Access-Token`.
- **CORS**: lock to `ALLOWED_ORIGINS`.
- **Strict validation & caps**:
  - SDP size ≤ **20 KB**; candidate size ≤ **1 KB**; ≤ **200** candidates/peer.
  - JSON schema check for known fields.
- **Rate limits**:
  - Create: **≤5/min/IP**.
  - Per-room mutations: **≤200/5 min** (both roles combined).
  - Join attempts: **≤10/min/IP** and **≤10/min/room**.
- **TTL touch**: Mutations may extend room TTL; Changing room states applies different types of TTL.
- **Observability**: counters for creates/joins/offers/answers/ice_appends/closes and 4xx/5xx/429.

## User Flow (Host + Guest)

1. **Host creates room**
   `POST /rooms` with body `{ "name": "Alice1996" }` → returns:
   ```json
   {
     "code": "ABCD12",
     "joinCode": "123456",
     "ownerToken": "<host capability>",
     "expiresAt": 1740001799999
   }
   ```
   Host shares **code** and **joinCode** with friend out‑of‑band.

2. **Guest searches for a room by code**
   `GET /rooms/:code/public` -> 200 would return only a currently open room, otherwise 404

3. **Guest sees the expected hostName (e.g., "Alice1996"), enters and redeems joinCode** 
   `POST /rooms/:code/join` with body `{ "joinCode": "123456", "name": "Bob1997" }` → returns:
   ```json
   { "guestToken": "<guest capability>", "expiresAt": 1740001799999 }
   ```
   Server marks room as "joined" (or rejects on reuse/expiry).

   Both parties poll the room status by using the polling endpoint:
   `GET /rooms/:code` (`X-Access-Token: ownerToken|guestToken`)

4. **Offer/Answer**
   - Host posts offer: `POST /rooms/:code/offer` (`X-Access-Token: ownerToken`)
   - Guest posts answer: `POST /rooms/:code/answer` (`X-Access-Token: guestToken`)
   - Server sets `status:"paired"` after valid answer.

5. **ICE exchange (both sides)**
   Each side posts candidates with their respective token:
   `POST /rooms/:code/candidate` (`X-Access-Token: ownerToken|guestToken`) → appends to `ice:<code>:host|guest`. The list is kept deduplicated, so dupes would not be added.
   Reader drains via `GET /rooms/:code/candidates` with `X-Access-Token` mandatory.

6. **Close**
   Host can close the room early: `POST /rooms/:code/close` (`X-Access-Token: ownerToken`) → `status:"closed"`, shrink TTL to acceptable destruction ASAP.

---

## REST API

### 1) Create Room
`POST /rooms`
- **Headers**: optional Turnstile / JWT.
- **Body**: `{ "name": "Alice1996" }` -> provides `hostName`
- **201**
  ```json
  { "code","ownerToken","joinCode","expiresAt" }
  ```
- Errors: `429`, `400/401` (Turnstile / JWT).

### 2) Get Public Room information by code
`GET /rooms/:code/public` 
- **200** { "status":"open", "expiresAt":..., "hostName": "" }
- **404** - in case the room doesn't exist, or not in an open state

### 3) Redeem Join Code → Guest Token
`POST /rooms/:code/join`
- **Body**: `{ "joinCode": "...", "name": "" }` -> provides `guestName`
- **200**: sets status to "joined"; wipes out `joinCode`; issues a `guestToken`
  ```json
  { "guestToken": "...", "expiresAt": 1740001799999 }
  ```
- Errors: `404` (room/expired), `409` (already paired or join code consumed), `400` (invalid), `429` (rate limited).

### 4) Put Offer (Host)
`POST /rooms/:code/offer`
- **Headers**: `X-Access-Token: ownerToken`
- **Body**: `{ "sdp": "<base64 SDP string>", "type": "offer" }`
- **Responses**
  - `204` no content
  - `403` bad/missing token
  - `404` room not found
  - `409` if offer already set and room not reset
- **Effect**: Merge `offer`; refresh TTL.

### 5) Put Answer (Guest)
`POST /rooms/:code/answer`
- **Headers**: `X-Access-Token: guestToken`
- **Body**: `{ "type":"answer", "sdp":"..." }`
- **204**; sets `status:"paired"`; errors as above.

### 6) Append ICE Candidate (Both)
`POST /rooms/:code/candidate`
- **Headers**: `X-Access-Token: ownerToken|guestToken`
- **Body**: `{ "candidate":"...", "sdpMid":"...", "sdpMLineIndex":0 }`
  server will infer whether this is a host or a guest from token claims/role.
- **204**; errors: `403/404/413`.

### 7) Fetch Room Snapshot (Poll)
`GET /rooms/:code`
- **Headers**: `X-Access-Token: ownerToken|guestToken`
- **200**
  ```json
  { "offer": {...} | null, "answer": {...} | null, "status": "open|joined|paired", "expiresAt": 1740001799999, "updatedAt": 1739999999999 }
  ```
- **404** if expired/missing/closed.

### 8) Drain ICE (Batch Read)
`GET /rooms/:code/candidates`
- **Headers**: `X-Access-Token: ownerToken|guestToken`
- **200** `{ "items":[...], "next": "<cursor|null>" }`
  server will infer whether this is a host or a guest from token claims/role, and return the current candidate list.

### 9) Close Room (Optional)
`POST /rooms/:code/close`
- **Headers**: `X-Access-Token: ownerToken`
- **204**; marks closed and shortens TTL.

---

## Validation & Limits (Server‑Side)
- **SDP**: presence/length/type fields; length ≤ 20 KB. Apply sanitization (e.g., stripping invalid lines in SDP that could exploit parsers)
- **Candidates**: required fields; length ≤ 1 KB; **≤200** per peer; body ≤ 64 KB total.
- **Room state constraints**: only one answer; error if already paired and another guest tries to join.
- **Join code**: must match, single use.

---

## App‑Level Handshake (HMAC)
After DataChannel opens, each side can send:
```json
{ "type": "hello", "proof": "HMAC_SHA256(<token>, <nonce>)", "nonce": "<random>" }
```
Close on failure or timeout. Prevents non‑Registry peers from completing the app protocol.

---

## Config (Env)
- `ROOM_TTL_SEC` default **60**
- `ICE_TTL_SEC` default **180**
- `ALLOWED_ORIGINS`
- `MAX_ROOM_WRITES_PER_5M` default **200**
- (Optional) `TURNSTILE_SECRET`
---

## Observability
- **Logs**: `event`, `code`, `ipHash`, `status`, `bytes`, `latencyMs`.
- **Metrics** (Durable Objects not required): counters for creates, joins, offers, answers, ice_appends, fetches, closes, rejects, rate_limits.

---

## Dev & Test
- Local dev: `wrangler dev` with KV binding.
- Happy path: Create → Guest redeem → Offer/Answer → ICE exchange → DataChannel open → Close.
- Same‑machine test: two tabs/windows; expect host candidates; STUN/TURN not required.

---

## Non‑Goals
- No public matchmaking/presence.
- No TURN/STUN provisioning (clients supply ICE).
- No game data relaying.

---

## Minimal Client Contract (Reference)
- All calls JSON; `Content-Type: application/json`.
- Mutations and sensitive operations require `X-Access-Token` (role‑scoped).
- Guest must redeem `joinCode` before posting `/answer` or `/candidate`.
- Stop polling Registry after DataChannel `open`.
