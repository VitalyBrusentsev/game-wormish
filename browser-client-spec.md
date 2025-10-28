# WebRTC Registry Client Module Specification
> Revision: 1.2

**Target**: TypeScript client for a 2‑player, room‑scoped WebRTC handshake using the “Registry” HTTP API.  

## Overview

This document specifies a TypeScript client module for browser applications that facilitates peer-to-peer WebRTC connections using the Cloudflare Registry API as a signaling server. The module abstracts the HTTP API interactions, manages WebRTC connection lifecycle, handles state transitions, and provides a clean interface for applications to establish real-time communication between two peers.

## References

- [Cloudflare Registry Design Specification](cloudflare/registry-api-spec.md)
- [Regisry OpenAPI specification (YAML)](cloudflare/openapi.yaml)

## Goals

- Provide a high-level API for room creation, joining, and WebRTC connection establishment
- Manage the complete WebRTC signaling flow using the Registry API
- Handle state transitions and error recovery
- Enable unit testing through dependency injection
- Follow TypeScript best practices with strong typing
- Abstract away the complexity of WebRTC and ICE/STUN configuration

## Design Principles

1. **Separation of Concerns**: The module will separate HTTP API communication, WebRTC connection management, and state management.
2. **Dependency Injection**: External dependencies (STUN/TURN servers, HTTP client) will be injectable for testability.
3. **Event-Driven Architecture**: The module will emit events for state changes, allowing applications to react appropriately.
4. **Type Safety**: Full TypeScript typing for all interfaces, methods, and callbacks.
5. **Error Resilience**: Robust error handling with clear error types and recovery strategies.

## CORS & CSRF Requirements

All HTTP requests must satisfy the Registry API's CORS contract described in `cloudflare/registry-api-spec.md`:

- Cross-origin requests are performed with `mode: "cors"` and `credentials: "omit"` because the Registry relies exclusively on bearer-style access tokens instead of cookies. Sending credentials causes the preflight to fail — the Worker does not echo `Access-Control-Allow-Credentials: true` — so requests must opt out of cookies entirely.
- Every mutation (`POST`) includes the non-simple header `X-Registry-Version: "1"` to force a preflight request for CSRF protection.
- Calls that require a capability token supply `X-Access-Token` in addition to the CSRF header.
- The default HTTP client used by the module is responsible for attaching these headers and fetch options automatically so that consumers cannot accidentally omit them.

## Architecture

The client module will consist of several key components, with a clear separation of interfaces and implementation in separate files:

1. **RegistryClient**: Handles HTTP communication with the Registry API
2. **WebRTCManager**: Manages the WebRTC peer connection and data channels
3. **RoomManager**: Orchestrates the room lifecycle and state transitions
4. **StateManager**: Manages the internal state of the connection process

## WebRTC Connection Establishment Flow

`RoomManager.startConnection()` coordinates the Registry signaling calls from `IRegistryClient`, peer-connection primitives from `IWebRTCManager`, and lifecycle tracking in `IStateManager` to walk both host and guest through the handshake. The flow below documents the phases in the order they occur so that spec readers can trace responsibilities to the appropriate interfaces.

### Phase 1: Room Provisioning and Admission

1. **Host creates the room**
   - Applications call `IRoomManager.createRoom(hostUserName)` which delegates to `IRegistryClient.createRoom`.
   - The Registry responds with a `RoomCreationResponse` (`code`, `ownerToken`, `joinCode`, `expiresAt`). The host stores the `ownerToken` in the state manager and distributes the room/join codes to the guest out-of-band.
   - `StateManager` transitions from `IDLE` → `CREATING` → `CREATED` and `RoomInfo.role` is set to `"host"` with the received token.

2. **Guest joins the room**
   - The guest calls `IRoomManager.joinRoom(roomCode, joinCode, guestUserName)` which invokes `IRegistryClient.joinRoom`.
   - On success the Registry returns a `RoomJoinResponse` carrying the `guestToken`; the state manager persists it alongside the shared room metadata.
   - The guest transitions `IDLE` → `JOINING` → `JOINED`, confirming the Registry has marked the room `status: "joined"` in subsequent `getRoom` polls.

### Phase 2: Offer/Answer Negotiation

1. **Peer-connection setup**
   - `RoomManager` builds an `RTCPeerConnection` via `IWebRTCManager.createPeerConnection(iceServers)` for both roles, registers `onIceCandidate`, `onConnectionStateChange`, and data-channel handlers, and persists the connection in `StateManager`.

2. **Host offers**
   - When `startConnection()` runs on the host, `RoomManager` invokes `IWebRTCManager.createOffer`, applies it locally with `setLocalDescription`, and immediately posts it through `IRegistryClient.postOffer(roomCode, ownerToken, offer)`.
   - Offer publication also flips the state to `CONNECTING` and primes ICE gathering.

3. **Guest answers**
   - The guest side polls `IRegistryClient.getRoom` on the configured polling cadence (see *Implementation Considerations · Polling Strategy*) until the `RoomSnapshot.offer` is populated.
   - `RoomManager` forwards the offer into `IWebRTCManager.createAnswer`, sets the local description, and pushes the answer to the Registry using `postAnswer(roomCode, guestToken, answer)`.
   - `StateManager` remains in `CONNECTING` while the answer waits for host retrieval.

4. **Host applies the answer**
   - The host continues `getRoom` polling until `RoomSnapshot.answer` is non-null, then commits it via `IWebRTCManager.setRemoteDescription`, completing the SDP exchange.

### Phase 3: Trickle ICE Exchange

1. **Candidate publication**
   - `RoomManager` subscribes to `IWebRTCManager.onIceCandidate`, forwarding every non-null candidate to `IRegistryClient.postCandidate` along with the caller’s token.
   - Candidates are deduplicated by the Registry; the `CandidateList.mode` values (`"full"` or `"delta"`) inform the client whether it should reset or append to the cached set.

2. **Candidate retrieval**
   - Both peers continue polling `getCandidates(roomCode, token)` on the same cadence used for room snapshots while they remain in `CONNECTING`.
   - Each candidate from the `CandidateList.items` array is fed into `IWebRTCManager.addIceCandidate`. The polling loop terminates once the data channel opens or the ICE gathering state reports `"failed"`, aligning with the polling rules in the implementation notes.

### Phase 4: Connection-State Monitoring

1. **ICE connectivity checks**
   - With SDP and trickled candidates in place, the browser runs ICE connectivity checks automatically. `RoomManager` watches `onconnectionstatechange` events via `IWebRTCManager.onConnectionStateChange` and updates `StateManager` to `CONNECTED` when the state becomes `"connected"`.

2. **Data channel negotiation**
   - The host creates an application data channel through `IWebRTCManager.createDataChannel`, while the guest listens via `IWebRTCManager.onDataChannel`.
   - Both peers wait for the channel’s `readyState` to reach `"open"` before emitting the application-facing `onMessage` callbacks.

3. **Failure detection**
   - If the peer connection enters `"failed"` or `"disconnected"`, `RoomManager` transitions to `ERROR` or `DISCONNECTED` respectively and raises `onError` so the application can react.

### Phase 5: Validation and Recovery

1. **Connection validation**
   - The module can emit a lightweight verification ping (for example, a JSON heartbeat) through `RoomManager.sendMessage` once the channel is open. Receipt through the corresponding `onMessage` callback confirms end-to-end delivery for both host and guest.

2. **Error handling**
   - **Offer/answer issues**: Timeouts while waiting for `RoomSnapshot.offer` or `.answer` trigger retries using the exponential-backoff strategy described in the error-handling section and surface actionable errors to consumers.
   - **Candidate gaps**: Missing or malformed candidates in `CandidateList` are ignored, while polling continues until the Registry reports no new deltas. `RoomManager` may request a fresh `mode: "full"` snapshot if sequence numbers stall.
   - **Connection failures**: When the ICE state remains `"failed"`, `RoomManager` moves the state to `ERROR`, calls `IRegistryClient.closeRoom` if the client is host, and exposes diagnostics (last known `RTCPeerConnectionState`, token role) through the error payload so applications can decide whether to restart the handshake.

3. **Cleanup**
   - Both roles call `closeRoom()` to revoke Registry resources and dispose of WebRTC objects once the session ends or an error becomes unrecoverable, ensuring parity with the lifecycle described in `src/webrtc/README.md`.

## Class and Interface Definitions

### 1. RegistryClient Interface

```typescript
interface IRegistryClient {
  createRoom(hostUserName: string): Promise<RoomCreationResponse>;
  getPublicRoomInfo(roomCode: string): Promise<PublicRoomInfo>;
  joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<RoomJoinResponse>;
  postOffer(roomCode: string, token: string, offer: RTCSessionDescriptionInit): Promise<void>;
  postAnswer(roomCode: string, token: string, answer: RTCSessionDescriptionInit): Promise<void>;
  postCandidate(roomCode: string, token: string, candidate: RTCIceCandidateInit): Promise<void>;
  getRoom(roomCode: string, token: string): Promise<RoomSnapshot>;
  getCandidates(roomCode: string, token: string): Promise<CandidateList>;
  closeRoom(roomCode: string, token: string): Promise<void>;
}

interface RoomCreationResponse {
  code: string;
  ownerToken: string;
  joinCode: string;
  expiresAt: number;
}

interface PublicRoomInfo {
  status: "open";
  expiresAt: number;
  hostUserName: string;
}

interface RoomJoinResponse {
  guestToken: string;
  expiresAt: number;
}

interface RoomSnapshot {
  status: "open" | "joined" | "paired" | "closed";
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  updatedAt: number;
  expiresAt: number;
}

interface CandidateList {
  items: RTCIceCandidateInit[];
  mode: "full" | "delta";
  lastSeq?: number;
}
```

### 2. WebRTCManager Interface

```typescript
interface IWebRTCManager {
  createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(offer: RTCSessionDescriptionInit, options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): RTCDataChannel;
  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void;
  onConnectionStateChange(callback: (state: RTCPeerConnectionState) => void): void;
  onDataChannel(callback: (channel: RTCDataChannel) => void): void;
}
```

### 3. RoomManager Interface

```typescript
interface IRoomManager {
  createRoom(hostUserName: string): Promise<RoomInfo>;
  joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<RoomInfo>;
  startConnection(): Promise<void>;
  closeRoom(): Promise<void>;
  onStateChange(callback: (state: ConnectionState) => void): void;
  onMessage(callback: (message: any) => void): void;
  sendMessage(message: any): void;
  getConnectionState(): ConnectionState;
  getRoomInfo(): RoomInfo | null;
}

interface RoomInfo {
  code: string;
  hostUserName?: string;
  guestUserName?: string;
  role: "host" | "guest";
  token: string;
  expiresAt: number;
}

enum ConnectionState {
  IDLE = "idle",
  CREATING = "creating",
  CREATED = "created",
  JOINING = "joining",
  JOINED = "joined",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  ERROR = "error"
}
```

### 4. StateManager Interface

```typescript
interface IStateManager {
  getState(): ConnectionState;
  setState(state: ConnectionState): void;
  getRoomInfo(): RoomInfo | null;
  setRoomInfo(roomInfo: RoomInfo): void;
  getPeerConnection(): RTCPeerConnection | null;
  setPeerConnection(connection: RTCPeerConnection): void;
  getDataChannel(): RTCDataChannel | null;
  setDataChannel(channel: RTCDataChannel): void;
  reset(): void;
}
```

### 5. Main Client Class

```typescript
interface IWebRTCRegistryClient {
  constructor(config: WebRTCClientConfig);
  
  // Host methods
  createRoom(hostUserName: string): Promise<string>;
  
  // Guest methods
  joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<void>;
  
  // Common methods
  startConnection(): Promise<void>;
  sendMessage(message: any): void;
  closeRoom(): Promise<void>;
  
  // Event handlers
  onStateChange(callback: (state: ConnectionState) => void): void;
  onMessage(callback: (message: any) => void): void;
  onError(callback: (error: Error) => void): void;
  
  // Getters
  getConnectionState(): ConnectionState;
  getRoomInfo(): RoomInfo | null;
}

interface WebRTCClientConfig {
  registryApiUrl: string;
  iceServers: RTCIceServer[];
  httpClient?: IHttpClient;
  webRTCManager?: IWebRTCManager;
  stateManager?: IStateManager;
}

interface IHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<any>;
  post(url: string, body?: any, headers?: Record<string, string>): Promise<any>;
}
```

## State Management

The client will maintain an internal state machine that tracks the connection lifecycle:

1. **IDLE**: Initial state, no room created or joined
2. **CREATING**: Host is creating a room
3. **CREATED**: Room created successfully, waiting for guest
4. **JOINING**: Guest is joining a room
5. **JOINED**: Guest joined successfully, ready to establish connection
6. **CONNECTING**: WebRTC connection is being established
7. **CONNECTED**: WebRTC connection is established and data channel is open. Application-level data can only be sent once the `RTCDataChannel`'s `readyState` is open.
8. **DISCONNECTED**: Connection was established but is now closed
9. **ERROR**: An error occurred during the process

State transitions will be managed by the StateManager and exposed through events to the application.

## Error Handling

The module will implement comprehensive error handling:

1. **API Errors**: Properly handle and translate Registry API errors (rate limiting, invalid codes, etc.)
2. **WebRTC Errors**: Handle WebRTC connection failures, ICE negotiation failures
3. **State Errors**: Prevent invalid state transitions
4. **Network Errors**: Handle network connectivity issues
5. **Timeout Errors**: Implement timeouts for operations

All errors will be typed and exposed through the error event handler.

## Testing Strategy

The module will be designed for comprehensive unit testing:

1. **Dependency Injection**: All external dependencies (HTTP client, WebRTC implementation) will be injectable
2. **Mock Implementations**: Provide mock implementations of all interfaces for testing
3. **State Testing**: Test all state transitions and edge cases
4. **Error Scenarios**: Test various error conditions and recovery paths

## Implementation Considerations

1. **Efficient Candidate handling**: The WebRTCManager should be bound to the RTCPeerConnection.onicecandidate event. When a candidate is generated, it should be sent immediately via registryClient.postCandidate(). The client should be designed to handle and add candidates idempotently, as the "full set" API might send the same candidates multiple times.
2. **Polling Strategy**: Implement efficient polling for room state and candidates. Manage the correct polling lifetime: the client should remove the polling loop as soon as the room changes status from states expected to be polled, or the first datachannel open event fires, or when pc.iceGatheringState becomes "failed".
3. **Rate Limiting**: Respect API rate limits with exponential backoff
4. **Connection Resilience**: Implement reconnection strategies for temporary network issues
5. **Memory Management**: Properly clean up WebRTC resources when closing connections
6. **Browser Compatibility**: Ensure compatibility across major browsers
7. **Data Validation**: Guard against incorrect candidate data values (filter out empty candidates)

## Usage Examples

### Host Example

```typescript
const config = {
  registryApiUrl: "https://registry.example.com",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const client = new WebRTCRegistryClient(config);

client.onStateChange((state) => {
  console.log("State changed:", state);
});

client.onMessage((message) => {
  console.log("Received message:", message);
});

client.onError((error) => {
  console.error("Error:", error);
});

// Create a room
const roomCode = await client.createRoom("Alice");
console.log("Room created with code:", roomCode);

// Start the connection when ready
await client.startConnection();

// Send a message
client.sendMessage({ type: "greeting", content: "Hello from host!" });
```

### Guest Example

```typescript
const config = {
  registryApiUrl: "https://registry.example.com",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const client = new WebRTCRegistryClient(config);

client.onStateChange((state) => {
  console.log("State changed:", state);
});

client.onMessage((message) => {
  console.log("Received message:", message);
});

client.onError((error) => {
  console.error("Error:", error);
});

// Join a room
await client.joinRoom("ABCD12", "123456", "Bob");

// Start the connection when ready
await client.startConnection();

// Send a message
client.sendMessage({ type: "greeting", content: "Hello from guest!" });
```

## Debugging Harness

The Debugging Harness is a standalone HTML page with form UI, allowing the user to choose a role of a host or a guest, requesting the necessary parameters (username, join code, etc), and testing the room handshake protocol, showing the room state in the process. The form controls should have discoverable attributes, suitable for page automation via Playwright.
Upon establishing a successful connection, it should allow a simple chat interface for text message exchange.

## Integration Testing

The integration testing of the client should be implemented via headless browser orchestration with Playwright within a Node.js test runner like Jest.
### Test Workflow
**Setup**: The test script starts a local instance of the registry API (`wrangler dev`).

**Launch Peers**: It launches two headless browser instances (e.g., Chromium), representing the "Host" and the "Guest".

**Orchestration**: The central test script acts as the "out-of-band" communicator:

- It instructs the Host browser to execute `client.createRoom('HostUser')`.
- It retrieves the resulting `roomCode` and `joinCode` from the Host browser's execution context.
- It passes these codes to the Guest browser.
- It instructs the Guest browser to execute `client.joinRoom(roomCode, joinCode, 'GuestUser')`.
- It then instructs both browsers to call `client.startConnection()`.

**Verification**:

- The test script listens for `onStateChange` events from both peers, asserting that they both eventually reach the `CONNECTED` state.
- To verify the data channel, the script instructs the Host to `sendMessage('ping')`. It then waits for the Guest's `onMessage` event and asserts that the received data is 'ping'.
- The process is repeated in the other direction (Guest to Host) to ensure bidirectional communication.

**Teardown**: The script closes the room and terminates the browser instances.

## Future Enhancements (Not in Scope)

1. **TURN Server Support**: Add support for TURN servers for NAT traversal
2. **Connection Metrics**: Expose connection quality metrics

## Conclusion

This specification outlines a comprehensive TypeScript client module for browser applications that abstracts the complexity of WebRTC connections using the Cloudflare Registry API. The module will provide a clean, testable, and robust interface for establishing peer-to-peer connections while handling all the intricacies of the signaling process.