# Network Match Wiring Plan

This document describes how to propagate the new `NetworkSessionState` into the Wormish UI and turn loop so that host/guest connections can be configured from the game shell. It is meant to serve as an implementation checklist for a future Codex session.

## 1. Ownership & Lifecycle

- `Game` owns a singleton `NetworkSessionState`, created alongside `GameSession` inside `game.ts`.
- Add `getNetworkState(): NetworkSessionState` plus helpers (`configureNetworkMode`, `updateNetworkStatus`, etc.) on `Game` so UI overlays can read/update state through callbacks instead of instantiating their own copies.
- `Game` also becomes responsible for instantiating `WebRTCRegistryClient` (import from `src/webrtc`), registering callbacks, and writing the resulting data into `NetworkSessionState`.
- Turn controllers: keep local controllers for both teams until `NetworkSessionState.bridge.networkReady` flips true, then swap the remote team’s controller to a `RemoteTurnController` and feed resolutions via its `receiveResolution` method.

## 2. New “Network Match” Dialog

We keep the existing start menu as-is, but when the player clicks “Play With Friends” we open a new dialog, also powered by `CommandDialog`. The dialog needs to support two sub-modes (Host, Guest) and a validation/progress panel.

### 2.1 Dialog structure

- Create `NetworkMatchDialog` under `src/ui/` that wraps a `CommandDialog`. Inputs to collect:
  - Player display name
  - Landing view that offers two primary choices: “Start a new Game” (host) or “Join a Game” (guest). The cancel button on this view dismisses the dialog.
  - Host flow: clicking “Start a new Game” immediately creates a room, then replaces the layout with room details (room code, join code, host name) and a single Cancel control that resets the dialog to its initial state.
  - Guest flow:
    1. Step 1: prompt only for the room code with a **Find** action and Cancel (which resets to landing).
    2. Step 2: once `/rooms/:code/public` returns the host, show a prominent “Found: Host <name>” callout plus the join-code input and a **Join** button.
    3. After a successful join, only the Cancel control remains while connection progress is displayed.
- Validation panel at the bottom shows errors or connection progress (text lines). Progress should be readable across all states (creating room, lookup, join, connecting, connected).
- Keep a detail list on the right showing the current room code, join code, expiration, and remote player name for quick confirmation whenever a network flow is active.

### 2.2 Dialog → Game wiring

- Dialog receives a controller object with methods:
  - `createHostRoom(config: { registryUrl: string; playerName: string; })`.
    - `registryUrl` should be hardcoded to `http://127.0.0.1:8787` for dev builds, or to `https://wormish-current-time-production.installcreator.workers.dev` for production builds.
  - `joinRoom(config: { registryUrl: string; playerName: string; roomCode: string; joinCode: string; })`.
  - `cancelNetworkSetup()` (to tear down partially initialized state if the dialog is closed mid-flow).
- `Game` implements these methods by mutating `NetworkSessionState`, instantiating the registry client when needed, and forwarding success/error diagnostics back into the dialog.
- Validation panel entries are derived from `NetworkSessionState.connection.lifecycle`, `registry.status`, and any recent diagnostics stored in the state (`lastError`, `debugEvents`).

## 3. WebRTC Client Integration

- Reuse the existing `WebRTCRegistryClient` (with debug events) from `src/webrtc/client.ts`.
- `Game` owns a client instance per network match. When the dialog requests host/guest flows:
  1. Call `NetworkSessionState.setMode("network-host" | "network-guest")`.
  2. Update `networkState.updateRegistryInfo({ baseUrl, code, joinCode, token, expiresAt, hostUserName, guestUserName })` after each API call result.
  3. Subscribe to `client.onStateChange`, `onMessage`, `onError`, and `onDebugEvent`:
     - Map `ConnectionState` enum transitions into `NetworkSessionState.updateConnectionLifecycle`.
     - Push debug events into a rolling list on `NetworkSessionState` (extend the type if necessary) for later display/diagnostics.
     - Store messages/resolutions on `NetworkSessionState.bridge` (e.g., data channel message containing `TurnResolution`).
- When `client.startConnection()` resolves and the data channel opens, set `bridge.networkReady = true` and flip the GameSession controllers as noted above.

## 4. HUD Widget

- Add a minimal overlay component (e.g., `NetworkStatusHUD`) rendered from `Game.render()` when `NetworkSessionState.mode !== "local"`.
- Content:
  - Connection state badge (use colors similar to debug harness state indicator).
  - Room info (`registry.code`, `registry.joinCode` for host until consumed, `hostUserName`/`guestUserName`).
  - Turn-wait indicator: show “Waiting for remote turn…” whenever `session.isWaitingForRemoteResolution()` is true and `networkReady` is true.
- Always visible for network matches, hidden for pure local play. No copy buttons—codes are just informative.

## 5. Error & Progress Surfacing

- Validation panel (inside the dialog) should observe `NetworkSessionState.connection.lastError`, `registry.status`, and `bridge` flags:
  - Example states: “Creating room…”, “Room created. Share code ABCD1234 / 987654”, “Guest joined; waiting for pairing…”, “Joined host Alice1996; submit join code to continue”, “Connecting…”, “Error: rate_limited (retry in 10s)”.
- Provide `Game`→dialog callbacks so the dialog can display asynchronous updates without polling (e.g., emit events when `NetworkSessionState` changes; simple approach: `Game` passes an `onNetworkStateChange` emitter to the dialog).
- When the dialog closes (user starts battle or cancels), ensure outstanding HTTP/WebRTC operations are either allowed to continue (if the match is starting) or cancelled (if aborting).

## 6. Implementation Steps

1. **State plumbing**
   - Instantiate `NetworkSessionState` in `Game`.
   - Add getters and mutation helpers; ensure state survives restarts if desired (else reset on `Game.restart()`).
2. **Dialog scaffolding**
   - Implement `NetworkMatchDialog` with host/guest tabs, validation panel, and the callbacks described above.
   - Modify `StartMenuOverlay` so “Play With Friends” opens this dialog (and disable the old placeholder string).
3. **Registry flows**
   - Host:
     - `createRoom` → update state with `code`, `joinCode`, `token`, `expiresAt`, `hostUserName`.
     - Immediately begin polling and connection setup; no explicit start button.
   - Guest:
     - `getPublicRoomInfo` to show host name.
     - `joinRoom` to acquire token, then automatically begin connection.
4. **WebRTC handshake**
   - Share the registry base URL + token with the client, call `startConnection`, feed debug events/state transitions into `NetworkSessionState`.
5. **Bridge→GameSession**
   - When remote resolutions arrive over the data channel, store them via `NetworkSessionState.enqueueResolution` and forward them to the relevant `RemoteTurnController`.
6. **HUD integration**
   - Render the status widget during gameplay; ensure updates react to `NetworkSessionState` changes (simple approach: `Game.render()` reads from state each frame).

Following this plan keeps `Game` as the authoritative owner of networking state, provides a clear UX for both host and guest setup, retains the verbose debug instrumentation for early troubleshooting, and surfaces connection status in-game via the HUD widget.
