# WebRTC Registry Client

A TypeScript client module for establishing peer-to-peer WebRTC connections using the Cloudflare Registry API for signaling.

## Overview

This module provides a high-level API for creating and joining WebRTC rooms, exchanging SDP offers/answers and ICE candidates, and establishing data channels for real-time communication between two peers.

## Architecture

The module is organized into several key components:

- **[`types.ts`](types.ts)** - Core TypeScript interfaces and type definitions
- **[`http-client.ts`](http-client.ts)** - HTTP client with CORS/CSRF protection
- **[`registry-client.ts`](registry-client.ts)** - Registry API communication layer
- **[`state-manager.ts`](state-manager.ts)** - Connection lifecycle state management
- **[`webrtc-manager.ts`](webrtc-manager.ts)** - WebRTC peer connection management
- **[`room-manager.ts`](room-manager.ts)** - Room orchestration and signaling flow
- **[`client.ts`](client.ts)** - Main client class (public API)
- **[`index.ts`](index.ts)** - Module exports

## Features

✅ **Room Creation & Joining** - Host creates rooms, guests join with codes  
✅ **Automatic Signaling** - SDP and ICE candidate exchange via Registry API  
✅ **State Management** - Track connection lifecycle with event notifications  
✅ **Data Channels** - Send/receive JSON messages between peers  
✅ **CORS/CSRF Protection** - Built-in security headers per API spec  
✅ **Candidate Filtering** - Filters mDNS and empty candidates  
✅ **Efficient Polling** - Smart polling with automatic cleanup  
✅ **Type Safety** - Full TypeScript typing throughout  
✅ **Testable** - Dependency injection for easy unit testing  

## Usage

### Basic Example (Host)

```typescript
import { WebRTCRegistryClient } from './webrtc';

const client = new WebRTCRegistryClient({
  registryApiUrl: 'https://registry.example.com',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// Set up event handlers
client.onStateChange((state) => {
  console.log('Connection state:', state);
});

client.onMessage((message) => {
  console.log('Received:', message);
});

client.onError((error) => {
  console.error('Error:', error);
});

// Create a room
const roomCode = await client.createRoom('Alice');
console.log('Share this room code:', roomCode);

// Start connection when ready
await client.startConnection();

// Send messages
client.sendMessage({ type: 'greeting', text: 'Hello!' });
```

### Basic Example (Guest)

```typescript
import { WebRTCRegistryClient } from './webrtc';

const client = new WebRTCRegistryClient({
  registryApiUrl: 'https://registry.example.com',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// Set up event handlers
client.onStateChange((state) => {
  console.log('Connection state:', state);
});

client.onMessage((message) => {
  console.log('Received:', message);
});

// Join a room
await client.joinRoom('ABCD1234', '123456', 'Bob');

// Start connection
await client.startConnection();

// Send messages
client.sendMessage({ type: 'greeting', text: 'Hi there!' });
```

## Connection States

The client maintains the following connection states:

- **`IDLE`** - Initial state, no room created or joined
- **`CREATING`** - Host is creating a room
- **`CREATED`** - Room created successfully, waiting for guest
- **`JOINING`** - Guest is joining a room
- **`JOINED`** - Guest joined successfully, ready to establish connection
- **`CONNECTING`** - WebRTC connection is being established
- **`CONNECTED`** - WebRTC connection established and data channel is open
- **`DISCONNECTED`** - Connection was established but is now closed
- **`ERROR`** - An error occurred during the process

## API Reference

### `WebRTCRegistryClient`

#### Constructor

```typescript
new WebRTCRegistryClient(config: WebRTCClientConfig)
```

**Config Options:**
- `registryApiUrl` (required) - URL of the Registry API
- `iceServers` (required) - Array of STUN/TURN servers
- `httpClient` (optional) - Custom HTTP client implementation
- `webRTCManager` (optional) - Custom WebRTC manager implementation
- `stateManager` (optional) - Custom state manager implementation

#### Methods

**`createRoom(hostUserName: string): Promise<string>`**  
Create a new room as host. Returns the room code to share with the guest.

**`joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<void>`**  
Join an existing room as guest.

**`startConnection(): Promise<void>`**  
Start the WebRTC connection process. Call after creating or joining a room.

**`sendMessage(message: any): void`**  
Send a JSON-serializable message through the data channel.

**`closeRoom(): Promise<void>`**  
Close the room and clean up resources.

**`onStateChange(callback: (state: ConnectionState) => void): void`**  
Register a callback for connection state changes.

**`onMessage(callback: (message: any) => void): void`**  
Register a callback for incoming messages.

**`onError(callback: (error: Error) => void): void`**  
Register a callback for errors.

**`getConnectionState(): ConnectionState`**  
Get the current connection state.

**`getRoomInfo(): RoomInfo | null`**  
Get the current room information.

## Testing

The module includes comprehensive unit tests for all components:

```bash
# Run tests
npm run test

# Run tests with coverage
npm run test:run
```

**Test Coverage:**
- ✅ HTTP Client (11 tests)
- ✅ Registry Client (9 tests)
- ✅ State Manager (16 tests)
- ✅ WebRTC Manager (22 tests)
- ✅ Main Client (6 tests)

## Debug Harness

A debugging harness HTML page is available at [`debug-harness.html`](../../debug-harness.html) for testing the client in a browser environment.

Features:
- Role selection (Host/Guest)
- Room creation and joining
- Connection state visualization
- Simple chat interface
- Discoverable test attributes for automation

To use the harness:

1. Start the Registry API locally: `cd cloudflare && wrangler dev`
2. Open [`debug-harness.html`](../../debug-harness.html) in a browser
3. Configure the Registry URL and STUN server
4. Select a role and follow the workflow

## Implementation Notes

### CORS & CSRF Protection

All HTTP requests are configured with:
- `mode: "cors"` - Enable CORS
- `credentials: "omit"` - No cookies (token-based auth)
- `X-Registry-Version: "1"` header on POST requests for CSRF protection
- `X-Access-Token` header for authenticated requests

### ICE Candidate Handling

- Candidates are sent immediately via [`registryClient.postCandidate()`](registry-client.ts#L113)
- mDNS candidates (containing `.local`) are filtered out
- Empty candidates are ignored
- Candidates are deduplicated using a composite key
- Polling stops when ICE gathering completes or data channel opens

### Polling Strategy

The client polls for:
- **Room state** - Every 1 second for offer/answer
- **ICE candidates** - Every 500ms for peer candidates

Polling automatically stops when:
- Room status changes to `paired` or `closed`
- Data channel opens
- ICE gathering state is `complete`

### Error Handling

All API errors include:
- `code` - Machine-readable error code
- `message` - Human-friendly description
- `retryable` - Whether the operation can be retried
- `retryAfterSec` - Optional retry delay for rate limiting

## Browser Compatibility

The module uses standard WebRTC APIs and is compatible with modern browsers:
- Chrome/Edge 56+
- Firefox 52+
- Safari 11+

## License

ISC License - See project LICENSE file