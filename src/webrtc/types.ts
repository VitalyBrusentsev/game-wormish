/**
 * Core type definitions for the WebRTC Registry Client
 */

// Connection States
export enum ConnectionState {
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

// Room Information
export interface RoomInfo {
  code: string;
  joinCode?: string; // Only present for host after room creation
  hostUserName?: string;
  guestUserName?: string;
  role: "host" | "guest";
  token: string;
  expiresAt: number;
}

// Registry API Response Types
export interface RoomCreationResponse {
  code: string;
  ownerToken: string;
  joinCode: string;
  expiresAt: number;
}

export interface PublicRoomInfo {
  status: "open";
  expiresAt: number;
  hostUserName: string;
}

export interface RoomJoinResponse {
  guestToken: string;
  expiresAt: number;
}

export interface RoomSnapshot {
  status: "open" | "joined" | "paired" | "closed";
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  updatedAt: number;
  expiresAt: number;
}

export interface CandidateList {
  items: RTCIceCandidateInit[];
  mode: "full" | "delta";
  lastSeq?: number;
}

// Debug events for instrumentation and tooling
export type DebugEvent =
  | {
      type: "room-snapshot";
      status: RoomSnapshot["status"];
      hasOffer: boolean;
      hasAnswer: boolean;
      timestamp: number;
    }
  | {
      type: "offer-posted" | "answer-posted";
      timestamp: number;
    }
  | {
      type: "remote-description-set";
      descriptionType: "offer" | "answer";
      timestamp: number;
    }
  | {
      type: "candidate-sent" | "candidate-buffered" | "candidate-applied";
      candidateKey: string;
      candidate: string;
      timestamp: number;
    }
  | {
      type: "candidate-error";
      candidateKey: string;
      candidate: string;
      message: string;
      timestamp: number;
    }
  | {
      type: "peer-connection-state";
      state: RTCPeerConnectionState;
      timestamp: number;
    }
  | {
      type: "peer-connection-error";
      state: RTCPeerConnectionState;
      reason: string;
      timestamp: number;
    }
  | {
      type: "data-channel-state";
      state: RTCDataChannelState;
      label: string;
      timestamp: number;
    };

// HTTP Client Interface
export interface IHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<any>;
  post(url: string, body?: any, headers?: Record<string, string>): Promise<any>;
}

// Registry Client Interface
export interface IRegistryClient {
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

// WebRTC Manager Interface
export interface IWebRTCManager {
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

// State Manager Interface
export interface IStateManager {
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

// Room Manager Interface
export interface IRoomManager {
  createRoom(hostUserName: string): Promise<RoomInfo>;
  joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<RoomInfo>;
  startConnection(): Promise<void>;
  closeRoom(): Promise<void>;
  onStateChange(callback: (state: ConnectionState) => void): void;
  onMessage(callback: (message: any) => void): void;
  onDebugEvent(callback: (event: DebugEvent) => void): void;
  sendMessage(message: any): void;
  getConnectionState(): ConnectionState;
  getRoomInfo(): RoomInfo | null;
}

// Main Client Configuration
export interface WebRTCClientConfig {
  registryApiUrl: string;
  iceServers: RTCIceServer[];
  httpClient?: IHttpClient;
  webRTCManager?: IWebRTCManager;
  stateManager?: IStateManager;
}

// Main Client Interface
export interface IWebRTCRegistryClient {
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
  onDebugEvent(callback: (event: DebugEvent) => void): void;

  // Getters
  getConnectionState(): ConnectionState;
  getRoomInfo(): RoomInfo | null;
}