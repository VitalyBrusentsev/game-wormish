/**
 * WebRTC Registry Client Module
 * 
 * A TypeScript client for establishing peer-to-peer WebRTC connections
 * using the Cloudflare Registry API for signaling.
 */

// Main client
export { WebRTCRegistryClient } from "./client";

// Types and interfaces
export {
  ConnectionState,
  type RoomInfo,
  type WebRTCClientConfig,
  type IWebRTCRegistryClient,
  type RoomCreationResponse,
  type PublicRoomInfo,
  type RoomJoinResponse,
  type RoomSnapshot,
  type CandidateList,
} from "./types";

// For advanced usage or testing
export { HttpClient } from "./http-client";
export { RegistryClient } from "./registry-client";
export { StateManager } from "./state-manager";
export { WebRTCManager } from "./webrtc-manager";
export { RoomManager } from "./room-manager";

export type {
  IHttpClient,
  IRegistryClient,
  IStateManager,
  IWebRTCManager,
  IRoomManager,
} from "./types";