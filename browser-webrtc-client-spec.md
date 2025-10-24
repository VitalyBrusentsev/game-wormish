# Browser WebRTC Client Module — Draft (ignore)
> Revision: 1.0

**Target**: TypeScript client for a 2‑player, room‑scoped WebRTC handshake using the “Registry” HTTP API.  
**Scope**: API surface, state model, responsibilities, dependency injection, error handling, polling/ICE semantics, security, and test plan.  

> This client targets the Registry semantics defined in **“Cloudflare ‘Registry’ API — Functional Requirements”**


---

## 1. Goals & Non‑Goals

### 1.1 Goals
- Provide a **minimal, dependency‑injectable TypeScript module** that a browser app can use to:
  - Create or join a **room**.
  - Exchange **SDP offer/answer** via the Registry.
  - **Publish** local ICE candidates and **drain** remote candidates (MVP: full‑set mode).
  - Establish a **WebRTC RTCPeerConnection** and open a **reliable/unreliable DataChannel** for gameplay packets.
  - Manage **client‑side state** (room/session lifecycle, tokens, timers, retry/backoff) with **deterministic** transitions.
- Be easy to **unit‑test**: all side‑effects are injected (fetch, timers, crypto/random, `RTCPeerConnection` factory, time source).

### 1.2 Non‑Goals
- No STUN/TURN provisioning. The app provides ICE servers via DI. 
- No media tracks (audio/video). **DataChannel only** (game data).
- No persistence beyond in‑memory state (caller decides if/what to persist).
- No direct logging of secrets/SDP/ICE strings (redact if app logs). 

---

## 2. External Constraints & Server Semantics (Assumed/MVP)

- **Room states**: `open → joined → paired → closed`; short TTLs per state. Clients should not rely on TTLs for correctness.
- **Headers**: Sensitive reads/writes require `X-Access-Token`; mutations must include a **non‑simple custom header**: `X-Registry-Version: 1`, to force preflight for CSRF protection.   
- **SDP & ICE caps**: SDP ≤ 20 KB; per‑peer candidates ≤ 40; candidate body ≤ 1 KB; request body ≤ 64 KB.
- **Draining ICE**: MVP returns the **complete set** for the *other side*; client applies **set‑difference** by `(candidate, sdpMid ?? "", sdpMLineIndex ?? -1)`.   
- **Rate limits**: public lookup, join attempts, per‑room mutations, etc.; client should surface `retryAfterSec` when present and implement backoff.   

---

## 3. Module Overview

### 3.1 Package Shape
```
@your-scope/registry-webrtc-client
├─ src/
│  ├─ client.ts           // main class: RegistryClient
│  ├─ state.ts            // state machine types & reducers
│  ├─ transport.ts        // fetch/HTTP helpers (DI)
│  ├─ rtc.ts              // RTCPeerConnection factory (DI)
│  ├─ ice.ts              // candidate set-diff & validators
│  ├─ errors.ts           // typed errors & mapping
│  ├─ timers.ts           // timers/backoff/clock (DI)
│  └─ types.ts            // public .d.ts-friendly types
├─ test/ (unit tests only; all I/O mocked)
└─ README.md
```

### 3.2 Public API (Types Only for the implementation to match)
```ts
export interface RegistryClientOptions {
  baseUrl: string; // e.g., "https://registry.example.com"
  allowedOrigin?: string; // for CORS preflight alignment
  fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  nowMs: () => number;        // time source
  setTimeoutImpl: (fn: () => void, ms: number) => any;
  clearTimeoutImpl: (t: any) => void;
  randomBytes: (len: number) => Uint8Array; // for local ids, not server tokens
  // WebRTC
  createPeerConnection: (cfg: RTCConfiguration) => RTCPeerConnection;
  rtcConfiguration: RTCConfiguration; // iceServers injected here
  // App policy
  iceDrainIntervalMs?: number;     // default 1000..1500ms (jittered)
  roomPollIntervalMs?: number;     // default 1000ms (post-offer until paired)
  maxCandidatesPerPeer?: number;   // default 40 (mirror server cap)
  csrfHeaderName?: string;         // default "X-Registry-Version"
  csrfHeaderValue?: string;        // default "1"
  userAgent?: string;              // optional UA header string
}

export type Role = "host" | "guest";

export interface CreateRoomInput { hostUserName: string; }
export interface CreateRoomResult {
  code: string; ownerToken: string; joinCode: string; expiresAt: number;
}

export interface PublicRoomInfo {
  status: "open"; hostUserName: string; expiresAt: number;
}

export interface JoinRoomInput { code: string; joinCode: string; guestUserName: string; }
export interface JoinRoomResult { guestToken: string; expiresAt: number; }

export interface OfferBody { type: "offer"; sdp: string; }
export interface AnswerBody { type: "answer"; sdp: string; }

export interface CandidateBody {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface DrainCandidatesResult {
  items: CandidateBody[];
  mode: "full";           // MVP only
  lastSeq?: number | 0;   // reserved
}

export interface DataChannelPolicy {
  label?: string;               // default "data"
  ordered?: boolean;            // default true (reliable)
  maxRetransmits?: number;      // optional for unreliable
  negotiated?: boolean;         // default false; if true, requires id
  id?: number;                  // optional if negotiated
}

export interface ConnectOptions {
  role: Role;
  code: string;
  accessToken: string;   // ownerToken or guestToken from Registry
  userName?: string;     // for client UI / logs (never sent in headers)
  dataChannel?: DataChannelPolicy;
}

export interface SendPacketOptions {
  reliable?: boolean; // if module offers dual channels
}

export interface RegistryClientEvents {
  onStateChange?(s: ClientState): void;
  onPeerConnection?(pc: RTCPeerConnection): void;
  onDataChannel?(dc: RTCDataChannel): void;
  onIceGatheringStateChange?(state: RTCIceGatheringState): void;
  onIceConnectionStateChange?(state: RTCPeerConnectionState): void;
  onCandidateLocal?(c: CandidateBody): void;    // after validation & dedupe
  onCandidateRemote?(c: CandidateBody): void;
  onOpen?(): void;         // DataChannel open
  onClose?(why?: string): void;
  onError?(err: Error): void;
}

export class RegistryClient {
  constructor(opts: RegistryClientOptions, ev?: RegistryClientEvents);

  // Room admin APIs (host-side convenience)
  createRoom(input: CreateRoomInput): Promise<CreateRoomResult>;
  fetchPublic(code: string): Promise<PublicRoomInfo | null>;
  joinRoom(input: JoinRoomInput): Promise<JoinRoomResult>;

  // WebRTC handshake & session
  connect(opts: ConnectOptions): Promise<void>; // drives offer/answer + ICE
  send(data: ArrayBufferView | ArrayBuffer | string, opts?: SendPacketOptions): boolean;
  close(reason?: string): void;

  // Introspection
  getState(): ClientState;
  getBufferedAmount(): number;
  getRoomSnapshot(): RoomSnapshot | null;
}

export interface RoomSnapshot {
  status: "open" | "joined" | "paired" | "closed";
  offer: OfferBody | null;
  answer: AnswerBody | null;
  updatedAt: number;
  expiresAt: number;
}

export type ClientPhase =
  | "idle"
  | "creating_room"
  | "waiting_guest"
  | "joining_room"
  | "posting_offer"
  | "posting_answer"
  | "polling_room"
  | "draining_ice"
  | "connecting_rtc"
  | "open"
  | "closing"
  | "closed"
  | "error";

export interface ClientState {
  role?: Role;
  code?: string;
  accessToken?: string;
  phase: ClientPhase;
  rtc?: {
    pc?: RTCPeerConnection;
    dc?: RTCDataChannel;
    localCandidates: Set<string>;   // dedupe key
    remoteCandidates: Set<string>;  // dedupe key
  };
  lastError?: { code: string; message: string; retryable?: boolean; retryAfterSec?: number };
  lastTransitionAt: number;
}
```

---

## 4. State Machine

### 4.1 High‑Level Phases (Host)
```
idle
 └─ createRoom → creating_room → waiting_guest
    └─ connect(role=host) → posting_offer
       ├─ poll room until answer present → paired
       ├─ start ICE publish loop (onicecandidate) → posting candidates
       ├─ start ICE drain loop (GET /candidates) → draining_ice
       └─ when pc/datachannel opens → open
```

### 4.2 High‑Level Phases (Guest)
```
idle
 └─ joinRoom → joining_room
    └─ connect(role=guest) → posting_answer
       ├─ start ICE publish loop (onicecandidate) → posting candidates
       ├─ start ICE drain loop (GET /candidates) → draining_ice
       └─ when pc/datachannel opens → open
```

### 4.3 Transition Rules
- `creating_room → waiting_guest` on 201 create success.
- `posting_offer → polling_room` after successful PUT offer; poll `/rooms/:code` with token until `answer` present. 
- `posting_answer` posts answer only after prior offer exists; 409 `no_offer` maps to recoverable error with retry (bounded). 
- `draining_ice` loop runs **until DataChannel open**, then stops (battery/network friendly). 
- Any terminal server state `closed` transitions client to `closed` and cancels timers. 


---

## 5. HTTP Integration (MVP)

### 5.1 Common Behavior
- Add `X-Access-Token` to all sensitive requests. 
- Add a **non‑simple header** (`X-Registry-Version: 1`) on **all mutations** to force CORS preflight. 
- Handle `429` with **exponential backoff** (cap at 10s) and honor `retryAfterSec` if present. 
- JSON only, `Content-Type: application/json`.

### 5.2 Endpoints Used
- `POST /rooms` → create
- `GET /rooms/:code/public` → public lookup
- `POST /rooms/:code/join` → redeem join code
- `POST /rooms/:code/offer` (host) → 204
- `POST /rooms/:code/answer` (guest) → 204; sets `status:"paired"`
- `GET /rooms/:code` (poll) → snapshot
- `POST /rooms/:code/candidate` (both) → 204
- `GET /rooms/:code/candidates` (both) → full set of *other side’s* candidates
- `POST /rooms/:code/close` (host optional) → 204  
All per 

### 5.3 ICE Candidate Handling
- **Publish**: listen to `pc.onicecandidate`; validate size; dedupe by key = `(candidate, sdpMid ?? "", sdpMLineIndex ?? -1)`; respect `maxCandidatesPerPeer` (default 40). 
- **Drain**: periodically `GET /candidates`; compute set‑difference vs. local `remoteCandidates`; call `pc.addIceCandidate` for only new entries; emit `onCandidateRemote` per addition. 
- **Stop** draining after DataChannel `open` (continue to accept late candidates from `onicecandidateerror` handling for a short grace, e.g., 2 cycles). 

### 5.4 Room Polling
- Host polls `/rooms/:code` after posting offer until `answer` present (or timeout aligned with TTL). Guest may poll opportunistically to observe `paired`. `?wait/since` are **not** relied upon (MVP may ignore). 


---

## 6. WebRTC Session

### 6.1 PeerConnection Creation
- Created via **DI factory** `createPeerConnection(rtcConfiguration)`; app provides `rtcConfiguration.iceServers` (e.g., public STUN, or private STUN/TURN). The client **never** fetches ICE servers itself. 

### 6.2 DataChannel Policy
- Default: **reliable, ordered** channel named `"data"`.
- Optionally support a second, **unreliable** channel (unordered, bounded retransmits) if `SendPacketOptions.reliable=false`.
- Expose `getBufferedAmount()` and **backpressure guard**: callers should avoid sending when `bufferedAmount` exceeds a module‑configurable threshold (e.g., 256 KiB), and the module will return `false` from `send()` while over threshold. 

### 6.3 Offer/Answer
- **Host** creates data channel *before* creating offer (ensures negotiated reliability flags propagate).
- **Guest** sets remote offer, creates/sets local answer.
- SDP strings must pass client‑side size checks before POST. 


---

## 7. Security & Privacy

- All sensitive ops require `X-Access-Token` (room‑scoped capability). Tokens are **opaque**, short‑lived. Do not log. 
- Include custom non‑simple header on mutations for CSRF preflight; do not echo sensitive headers in errors. 
- Never expose SDP or full candidate strings in client logs by default; offer an **opt‑in redaction policy**.
- Respect **rate limits** and surface **retryAfterSec** to upper layers for UI backoff. 


---

## 8. Error Model

### 8.1 Mapping Server Errors → Typed Errors
- Server envelope: `{ error: { code, message, retryable?, retryAfterSec? } }`. Map `code` to a discriminated union:
  - `bad_join_code`, `not_open`, `already_paired`, `no_offer`, `rate_limited`, `forbidden`, `not_found`, `body_too_large`, `bad_candidate`, `bad_sdp`. 
- 429 → `RateLimitedError` with `retryAfterSec` if present. 
- 403/404/409 per endpoint semantics; guidance:
  - `no_offer` (guest posting answer early) → short retry (≤2s jittered), then fail after N attempts.
  - `already_paired` → transition to `closed` unless caller explicitly retries from scratch.
  - `not_found/closed` → terminal.

### 8.2 Local Validation Errors
- `SdpTooLargeError`, `CandidateTooLargeError`, `TooManyCandidatesError`, etc.
- `TransitionError` when public API usage violates legal phase transitions.


---

## 9. Backoff, Timing & Cancellation

- **Exponential backoff** with jitter: base 250–500ms, multiplier 1.6–2.0, cap 10s (honor `retryAfterSec`).  
- **Cancellation**: all periodic tasks (polling, draining, retries) are canceled on `close()` / terminal errors / `closed`.  
- **Timeouts**: host/guest operations should **not** exceed the server TTL windows; module uses conservative client‑side timeouts (e.g., 45–60s for offer→answer wait in MVP). 


---

## 10. Unit Testing Strategy (Requirements)

> All external effects are mocked; **no real network**, **no real STUN/TURN**.

### 10.1 Fixtures
- **MockFetch**: routes method+path → scripted JSON (success/429/4xx/5xx).  
- **MockRTC**: deterministic `RTCPeerConnection` with injectable event queues:
  - `createOffer()` / `createAnswer()` return bounded SDP strings (size controls).
  - `onicecandidate` yields a programmed stream of candidates (including dupes / oversize to test validation).
- **MockTimers**: virtual clock; control timeouts and backoff.
- **MockCrypto**: deterministic `randomBytes` for stable ids.

### 10.2 Test Matrix (Illustrative)
- **Happy path** (host+guest): Create → Join → Offer/Answer → ICE publish/drain → DataChannel `open` → Close.
- **Rate limiting**: 429 with `retryAfterSec` honored; verify capped backoff.
- **SDP/ICE validation**: reject oversize; dedupe by key; enforce max 40 candidates. 
- **State transitions**: illegal calls (e.g., `send()` before `open`) throw `TransitionError`.
- **Room closure**: server flips to `closed`; client tears down and cancels timers.
- **Network hiccups**: transient 5xx then recovery.
- **ICE delta compatibility** (future): tolerate `mode:"delta"` without breaking (ignore unknown fields). 


---

## 11. Telemetry (Optional, Redacted)

- Events: `phase_change`, `request`, `response`, `retry`, `pc_state`, `dc_open`, `dc_close`.  
- Fields: redact SDP/candidate/token values; keep sizes/latencies only, matching server observability principles. 


---

## 12. Example Usage (Sketch, Not Implementation)

```ts
import { RegistryClient } from "@your-scope/registry-webrtc-client";

const client = new RegistryClient(
  {
    baseUrl: "https://registry.example.com",
    fetchImpl: window.fetch.bind(window),
    nowMs: () => performance.now(),
    setTimeoutImpl: (f, ms) => setTimeout(f, ms),
    clearTimeoutImpl: (t) => clearTimeout(t),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    createPeerConnection: (cfg) => new RTCPeerConnection(cfg),
    rtcConfiguration: { iceServers: [ /* provided by app */ ] },
  },
  {
    onOpen: () => console.log("datachannel open"),
    onError: (e) => console.error(e),
  }
);

// Host flow
const { code, ownerToken } = await client.createRoom({ hostUserName: "Alice1996" });
await client.connect({ role: "host", code, accessToken: ownerToken });

// Later, send gameplay data (module enforces backpressure via bufferedAmount)
client.send(new Uint8Array([1,2,3]).buffer);
```


---

## 13. Future Compatibility

- When backend introduces `If-None-Match` / `?wait/since` for long‑poll and `candidates?since=...` with `"mode":"delta"`, the client should:
  - Prefer delta mode if advertised while maintaining **MVP fallback** (full‑set).  
  - Preserve public types to avoid breaking apps; add optional fields only. 


---

## 14. Acceptance Criteria

- **Type‑safe** public API compiled under `strict` mode.
- **100% branch coverage** on the state reducer and HTTP/RTC orchestration paths (with mocks).
- Demonstrated **no direct STUN/TURN provisioning**; `rtcConfiguration` comes from DI. 
- Demonstrated **no direct global side‑effects** (no global timers, no global fetch); all are injected.
- Clean failure behavior under `429`, `403`, `404`, and `409` per server semantics. 
- ICE dedupe and cap honored; stop polling/draining after DataChannel `open`. 
