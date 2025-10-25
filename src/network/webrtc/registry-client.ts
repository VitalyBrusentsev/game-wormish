import { EventEmitter } from "./utils/event-emitter";

export interface IHttpClient {
  get(url: string, headers?: Record<string, string>): Promise<any>;
  post(url: string, body?: any, headers?: Record<string, string>): Promise<any>;
}

export interface IRegistryClient {
  createRoom(hostUserName: string): Promise<RoomCreationResponse>;
  getPublicRoomInfo(roomCode: string): Promise<PublicRoomInfo>;
  joinRoom(
    roomCode: string,
    joinCode: string,
    guestUserName: string
  ): Promise<RoomJoinResponse>;
  postOffer(
    roomCode: string,
    token: string,
    offer: RTCSessionDescriptionInit
  ): Promise<void>;
  postAnswer(
    roomCode: string,
    token: string,
    answer: RTCSessionDescriptionInit
  ): Promise<void>;
  postCandidate(
    roomCode: string,
    token: string,
    candidate: RTCIceCandidateInit
  ): Promise<void>;
  getRoom(roomCode: string, token: string): Promise<RoomSnapshot>;
  getCandidates(
    roomCode: string,
    token: string
  ): Promise<CandidateList>;
  closeRoom(roomCode: string, token: string): Promise<void>;
}

export interface IWebRTCManager {
  createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(
    label: string,
    dataChannelDict?: RTCDataChannelInit
  ): RTCDataChannel;
  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void;
  onConnectionStateChange(
    callback: (state: RTCPeerConnectionState) => void
  ): void;
  onDataChannel(callback: (channel: RTCDataChannel) => void): void;
}

export interface IStateManager {
  getState(): ConnectionState;
  setState(state: ConnectionState): void;
  getRoomInfo(): RoomInfo | null;
  setRoomInfo(roomInfo: RoomInfo): void;
  getPeerConnection(): RTCPeerConnection | null;
  setPeerConnection(connection: RTCPeerConnection | null): void;
  getDataChannel(): RTCDataChannel | null;
  setDataChannel(channel: RTCDataChannel | null): void;
  reset(): void;
}

export interface WebRTCClientConfig {
  registryApiUrl: string;
  iceServers: RTCIceServer[];
  httpClient?: IHttpClient;
  webRTCManager?: IWebRTCManager;
  stateManager?: IStateManager;
  pollIntervalMs?: number;
}

export interface RoomInfo {
  code: string;
  hostUserName?: string;
  guestUserName?: string;
  role: "host" | "guest";
  token: string;
  expiresAt: number;
  joinCode?: string;
}

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

export enum ConnectionState {
  IDLE = "idle",
  CREATING = "creating",
  CREATED = "created",
  JOINING = "joining",
  JOINED = "joined",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  ERROR = "error",
}

export type StateChangeListener = (state: ConnectionState) => void;
export type MessageListener = (message: unknown) => void;
export type ErrorListener = (error: Error) => void;

export type DebugEventType =
  | "state"
  | "createRoom"
  | "joinRoom"
  | "startConnection"
  | "offer"
  | "answer"
  | "iceCandidate"
  | "candidates"
  | "dataChannel"
  | "connectionState"
  | "closeRoom"
  | "error";

export interface DebugEvent {
  type: DebugEventType;
  message: string;
  details?: unknown;
}

export type DebugListener = (event: DebugEvent) => void;

type InternalEvents = Record<string, unknown> & {
  state: ConnectionState;
  message: unknown;
  error: Error;
  debug: DebugEvent;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;

const REGISTRY_VERSION_HEADER = "X-Registry-Version";
const REGISTRY_VERSION_VALUE = "1";

class DefaultHttpClient implements IHttpClient {
  async get(url: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await fetch(url, {
      mode: "cors",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      credentials: "omit",
    });

    if (!response.ok) {
      throw await createHttpError(response);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async post(
    url: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<any> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      credentials: "omit",
      mode: "cors",
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      throw await createHttpError(response);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }
}

async function createHttpError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const data = await response.json();
    if (data?.error?.message) {
      message = data.error.message;
    }
  } catch (error) {
    // Ignore JSON parse errors and keep default message
  }

  return new Error(message);
}

class RegistryHttpClient implements IRegistryClient {
  constructor(private readonly baseUrl: string, private readonly http: IHttpClient) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async createRoom(hostUserName: string): Promise<RoomCreationResponse> {
    return this.http.post(
      this.url("/rooms"),
      { hostUserName },
      withCsrfHeader()
    );
  }

  async getPublicRoomInfo(roomCode: string): Promise<PublicRoomInfo> {
    return this.http.get(this.url(`/rooms/${roomCode}/public`));
  }

  async joinRoom(
    roomCode: string,
    joinCode: string,
    guestUserName: string
  ): Promise<RoomJoinResponse> {
    return this.http.post(
      this.url(`/rooms/${roomCode}/join`),
      {
        joinCode,
        guestUserName,
      },
      withCsrfHeader()
    );
  }

  async postOffer(
    roomCode: string,
    token: string,
    offer: RTCSessionDescriptionInit
  ): Promise<void> {
    await this.http.post(
      this.url(`/rooms/${roomCode}/offer`),
      offer,
      withAuthenticatedHeaders(token)
    );
  }

  async postAnswer(
    roomCode: string,
    token: string,
    answer: RTCSessionDescriptionInit
  ): Promise<void> {
    await this.http.post(
      this.url(`/rooms/${roomCode}/answer`),
      answer,
      withAuthenticatedHeaders(token)
    );
  }

  async postCandidate(
    roomCode: string,
    token: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    await this.http.post(
      this.url(`/rooms/${roomCode}/candidate`),
      candidate,
      withAuthenticatedHeaders(token)
    );
  }

  async getRoom(roomCode: string, token: string): Promise<RoomSnapshot> {
    return this.http.get(
      this.url(`/rooms/${roomCode}`),
      withAccessTokenHeader(token)
    );
  }

  async getCandidates(
    roomCode: string,
    token: string
  ): Promise<CandidateList> {
    return this.http.get(
      this.url(`/rooms/${roomCode}/candidates`),
      withAccessTokenHeader(token)
    );
  }

  async closeRoom(roomCode: string, token: string): Promise<void> {
    await this.http.post(
      this.url(`/rooms/${roomCode}/close`),
      undefined,
      withAuthenticatedHeaders(token)
    );
  }
}

class StateManager implements IStateManager {
  private state: ConnectionState = ConnectionState.IDLE;
  private roomInfo: RoomInfo | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

  getState(): ConnectionState {
    return this.state;
  }

  setState(state: ConnectionState): void {
    this.state = state;
  }

  getRoomInfo(): RoomInfo | null {
    return this.roomInfo;
  }

  setRoomInfo(roomInfo: RoomInfo): void {
    this.roomInfo = roomInfo;
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.peerConnection;
  }

  setPeerConnection(connection: RTCPeerConnection | null): void {
    this.peerConnection = connection;
  }

  getDataChannel(): RTCDataChannel | null {
    return this.dataChannel;
  }

  setDataChannel(channel: RTCDataChannel | null): void {
    this.dataChannel = channel;
  }

  reset(): void {
    this.state = ConnectionState.IDLE;
    this.roomInfo = null;
    this.peerConnection = null;
    this.dataChannel = null;
  }
}

class WebRTCManager implements IWebRTCManager {
  private peerConnection: RTCPeerConnection | null = null;
  private iceCallback: ((candidate: RTCIceCandidateInit) => void) | null = null;
  private connectionStateCallback:
    | ((state: RTCPeerConnectionState) => void)
    | null = null;
  private dataChannelCallback:
    | ((channel: RTCDataChannel) => void)
    | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
    this.peerConnection = new RTCPeerConnection({ iceServers });
    this.pendingIceCandidates = [];
    this.peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      const candidate = event.candidate.toJSON();
      // Ignore end-of-candidates pseudo-events where the candidate string is empty
      if (!candidate.candidate || candidate.candidate.trim().length === 0) {
        return;
      }
      if (this.iceCallback) {
        this.iceCallback(candidate);
      } else {
        this.pendingIceCandidates.push(candidate);
      }
    };
    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection && this.connectionStateCallback) {
        this.connectionStateCallback(this.peerConnection.connectionState);
      }
    };
    this.peerConnection.ondatachannel = (event) => {
      if (this.dataChannelCallback) {
        this.dataChannelCallback(event.channel);
      }
    };
    return this.peerConnection;
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    return this.peerConnection;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    return descriptionToInit(pc.localDescription, offer);
  }

  async createAnswer(
    options?: RTCAnswerOptions
  ): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    const answer = await pc.createAnswer(options);
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);
    return descriptionToInit(pc.localDescription, answer);
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.setLocalDescription(description);
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(description);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.addIceCandidate(candidate);
  }

  createDataChannel(
    label: string,
    dataChannelDict?: RTCDataChannelInit
  ): RTCDataChannel {
    const pc = this.ensurePeerConnection();
    return pc.createDataChannel(label, dataChannelDict);
  }

  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void {
    this.iceCallback = callback;
    if (this.pendingIceCandidates.length > 0) {
      const pending = this.pendingIceCandidates;
      this.pendingIceCandidates = [];
      for (const candidate of pending) {
        this.iceCallback(candidate);
      }
    }
  }

  onConnectionStateChange(
    callback: (state: RTCPeerConnectionState) => void
  ): void {
    this.connectionStateCallback = callback;
  }

  onDataChannel(callback: (channel: RTCDataChannel) => void): void {
    this.dataChannelCallback = callback;
  }
}

function withCsrfHeader(
  headers: Record<string, string> = {}
): Record<string, string> {
  return {
    [REGISTRY_VERSION_HEADER]: REGISTRY_VERSION_VALUE,
    ...headers,
  };
}

function withAccessTokenHeader(token: string): Record<string, string> {
  return {
    "X-Access-Token": token,
  };
}

function withAuthenticatedHeaders(token: string): Record<string, string> {
  return withCsrfHeader(withAccessTokenHeader(token));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    return data;
  }
}

export class WebRTCRegistryClient {
  private readonly registryClient: IRegistryClient;
  private readonly webRTCManager: IWebRTCManager;
  private readonly stateManager: IStateManager;
  private readonly pollIntervalMs: number;
  private readonly events = new EventEmitter<InternalEvents>();
  private remoteCandidateKeys = new Set<string>();
  private polling = false;
  private isClosing = false;

  constructor(private readonly config: WebRTCClientConfig) {
    const httpClient = config.httpClient ?? new DefaultHttpClient();
    this.registryClient = new RegistryHttpClient(
      config.registryApiUrl,
      httpClient
    );
    this.webRTCManager = config.webRTCManager ?? new WebRTCManager();
    this.stateManager = config.stateManager ?? new StateManager();
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async createRoom(hostUserName: string): Promise<string> {
    this.updateState(ConnectionState.CREATING);
    try {
      const response = await this.registryClient.createRoom(hostUserName);
      const roomInfo: RoomInfo = {
        code: response.code,
        hostUserName,
        role: "host",
        token: response.ownerToken,
        expiresAt: response.expiresAt,
        joinCode: response.joinCode,
      };
      this.stateManager.setRoomInfo(roomInfo);
      this.updateState(ConnectionState.CREATED);
      this.logDebug({
        type: "createRoom",
        message: "Room created",
        details: {
          code: response.code,
          expiresAt: response.expiresAt,
        },
      });
      return response.code;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async joinRoom(
    roomCode: string,
    joinCode: string,
    guestUserName: string
  ): Promise<void> {
    this.updateState(ConnectionState.JOINING);
    try {
      const response = await this.registryClient.joinRoom(
        roomCode,
        joinCode,
        guestUserName
      );
      const roomInfo: RoomInfo = {
        code: roomCode,
        guestUserName,
        role: "guest",
        token: response.guestToken,
        expiresAt: response.expiresAt,
      };
      this.stateManager.setRoomInfo(roomInfo);
      this.updateState(ConnectionState.JOINED);
      this.logDebug({
        type: "joinRoom",
        message: "Joined room",
        details: {
          code: roomCode,
          expiresAt: response.expiresAt,
        },
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async startConnection(): Promise<void> {
    if (this.polling) {
      return;
    }

    const roomInfo = this.requireRoomInfo();
    const currentState = this.stateManager.getState();
    if (
      currentState === ConnectionState.CONNECTED ||
      currentState === ConnectionState.CONNECTING
    ) {
      return;
    }

    this.isClosing = false;
    this.remoteCandidateKeys.clear();
    this.updateState(ConnectionState.CONNECTING);
    this.logDebug({
      type: "startConnection",
      message: "Starting connection",
      details: { role: roomInfo.role },
    });

    const peerConnection = this.webRTCManager.createPeerConnection(
      this.config.iceServers
    );
    this.stateManager.setPeerConnection(peerConnection);
    this.logDebug({
      type: "startConnection",
      message: "Peer connection created",
      details: { iceServers: this.config.iceServers.map((server) => server.urls) },
    });

    const role = roomInfo.role;

    if (role === "host") {
      const dataChannel = this.webRTCManager.createDataChannel("game-data");
      this.setupDataChannel(dataChannel);
      this.logDebug({
        type: "dataChannel",
        message: "Host created data channel",
        details: { label: dataChannel.label },
      });
    } else {
      this.webRTCManager.onDataChannel((channel) => {
        this.logDebug({
          type: "dataChannel",
          message: "Guest received data channel",
          details: { label: channel.label },
        });
        this.setupDataChannel(channel);
      });
    }

    this.webRTCManager.onIceCandidate(async (candidate) => {
      this.logDebug({
        type: "iceCandidate",
        message: "Local ICE candidate gathered",
        details: candidate,
      });
      try {
        await this.registryClient.postCandidate(
          roomInfo.code,
          roomInfo.token,
          candidate
        );
        this.logDebug({
          type: "iceCandidate",
          message: "Local ICE candidate posted",
          details: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
        });
      } catch (error) {
        this.handleError(error);
      }
    });

    this.webRTCManager.onConnectionStateChange((state) => {
      this.logDebug({
        type: "connectionState",
        message: "Peer connection state changed",
        details: { state },
      });
      if (state === "connected") {
        this.updateState(ConnectionState.CONNECTED);
      } else if (state === "disconnected" || state === "failed") {
        this.updateState(ConnectionState.DISCONNECTED);
      }
    });

    try {
      if (role === "host") {
        await this.handleHostConnection(roomInfo);
      } else {
        await this.handleGuestConnection(roomInfo);
      }
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  sendMessage(message: unknown): void {
    const dataChannel = this.stateManager.getDataChannel();
    if (!dataChannel || dataChannel.readyState !== "open") {
      throw new Error("Data channel is not open");
    }

    const payload = typeof message === "string" ? message : JSON.stringify(message);
    dataChannel.send(payload);
  }

  async closeRoom(): Promise<void> {
    const roomInfo = this.stateManager.getRoomInfo();
    this.isClosing = true;
    this.polling = false;
    this.remoteCandidateKeys.clear();
    this.logDebug({
      type: "closeRoom",
      message: "Closing room",
      details: { code: roomInfo?.code ?? null },
    });

    const peerConnection = this.stateManager.getPeerConnection();
    if (peerConnection) {
      peerConnection.close();
      this.stateManager.setPeerConnection(null);
    }

    const dataChannel = this.stateManager.getDataChannel();
    if (dataChannel) {
      dataChannel.close();
      this.stateManager.setDataChannel(null);
    }

    if (roomInfo?.role === "host") {
      try {
        await this.registryClient.closeRoom(roomInfo.code, roomInfo.token);
      } catch (error) {
        this.handleError(error);
        throw error;
      }
    }

    this.stateManager.reset();
    this.updateState(ConnectionState.IDLE);
  }

  onStateChange(callback: StateChangeListener): void {
    this.events.on("state", callback);
  }

  onMessage(callback: MessageListener): void {
    this.events.on("message", callback);
  }

  onError(callback: ErrorListener): void {
    this.events.on("error", callback);
  }

  onDebug(callback: DebugListener): void {
    this.events.on("debug", callback);
  }

  getConnectionState(): ConnectionState {
    return this.stateManager.getState();
  }

  getRoomInfo(): RoomInfo | null {
    return this.stateManager.getRoomInfo();
  }

  private setupDataChannel(dataChannel: RTCDataChannel): void {
    this.stateManager.setDataChannel(dataChannel);
    dataChannel.onopen = () => {
      if (!this.isClosing) {
        this.updateState(ConnectionState.CONNECTED);
      }
      this.logDebug({
        type: "dataChannel",
        message: "Data channel open",
        details: { label: dataChannel.label },
      });
    };
    dataChannel.onclose = () => {
      if (!this.isClosing) {
        this.updateState(ConnectionState.DISCONNECTED);
      }
      this.logDebug({
        type: "dataChannel",
        message: "Data channel closed",
        details: { label: dataChannel.label },
      });
    };
    dataChannel.onmessage = (event) => {
      const parsed = typeof event.data === "string" ? parseMessage(event.data) : event.data;
      this.events.emit("message", parsed);
      this.logDebug({
        type: "dataChannel",
        message: "Data channel message received",
        details: { label: dataChannel.label },
      });
    };
  }

  private async handleHostConnection(roomInfo: RoomInfo): Promise<void> {
    this.logDebug({
      type: "offer",
      message: "Creating offer",
      details: { code: roomInfo.code },
    });
    const offer = await this.webRTCManager.createOffer();
    await this.registryClient.postOffer(roomInfo.code, roomInfo.token, offer);
    this.logDebug({
      type: "offer",
      message: "Offer posted",
      details: { sdpType: offer.type },
    });
    await this.waitForAnswer(roomInfo);
    this.startCandidateDrain(roomInfo);
  }

  private async handleGuestConnection(roomInfo: RoomInfo): Promise<void> {
    this.logDebug({
      type: "offer",
      message: "Waiting for offer",
      details: { code: roomInfo.code },
    });
    const offer = await this.waitForOffer(roomInfo);
    await this.webRTCManager.setRemoteDescription(offer);
    this.recordRemoteDescriptionCandidates(offer);
    this.logDebug({
      type: "offer",
      message: "Offer applied",
      details: { sdpType: offer.type },
    });
    const answer = await this.webRTCManager.createAnswer();
    await this.registryClient.postAnswer(roomInfo.code, roomInfo.token, answer);
    this.logDebug({
      type: "answer",
      message: "Answer posted",
      details: { sdpType: answer.type },
    });
    this.startCandidateDrain(roomInfo);
  }

  private async waitForAnswer(roomInfo: RoomInfo): Promise<void> {
    this.polling = true;
    this.logDebug({
      type: "answer",
      message: "Polling for answer",
      details: { code: roomInfo.code },
    });
    while (!this.isClosing) {
      const snapshot = await this.registryClient.getRoom(
        roomInfo.code,
        roomInfo.token
      );
      if (snapshot.answer) {
        await this.webRTCManager.setRemoteDescription(snapshot.answer);
        this.recordRemoteDescriptionCandidates(snapshot.answer);
        this.polling = false;
        this.logDebug({
          type: "answer",
          message: "Answer received",
          details: { status: snapshot.status },
        });
        return;
      }
      await wait(this.pollIntervalMs);
    }
  }

  private async waitForOffer(roomInfo: RoomInfo): Promise<RTCSessionDescriptionInit> {
    this.polling = true;
    this.logDebug({
      type: "offer",
      message: "Polling for offer",
      details: { code: roomInfo.code },
    });
    while (!this.isClosing) {
      const snapshot = await this.registryClient.getRoom(
        roomInfo.code,
        roomInfo.token
      );
      if (snapshot.offer) {
        this.polling = false;
        this.logDebug({
          type: "offer",
          message: "Offer received",
          details: { status: snapshot.status },
        });
        return snapshot.offer;
      }
      await wait(this.pollIntervalMs);
    }
    throw new Error("Connection cancelled");
  }

  private startCandidateDrain(roomInfo: RoomInfo): void {
    if (this.isClosing) {
      return;
    }

    this.logDebug({
      type: "candidates",
      message: "Starting remote candidate drain",
      details: { code: roomInfo.code },
    });
    void this.drainRemoteCandidates(roomInfo);
  }

  private async drainRemoteCandidates(roomInfo: RoomInfo): Promise<void> {
    while (!this.isClosing) {
      try {
        const candidateList = await this.registryClient.getCandidates(
          roomInfo.code,
          roomInfo.token
        );
        const newCandidates: RTCIceCandidateInit[] = [];
        for (const candidate of candidateList.items) {
          const key = candidateKey(candidate);
          if (!this.remoteCandidateKeys.has(key)) {
            this.remoteCandidateKeys.add(key);
            newCandidates.push(candidate);
            await this.webRTCManager.addIceCandidate(candidate);
          }
        }
        this.logDebug({
          type: "candidates",
          message: `Fetched ${candidateList.items.length} remote candidates`,
          details: {
            applied: newCandidates.length,
            knownTotal: this.remoteCandidateKeys.size,
            mode: candidateList.mode,
            lastSeq: candidateList.lastSeq,
            newCandidates,
          },
        });
      } catch (error) {
        this.handleError(error);
        return;
      }
      await wait(this.pollIntervalMs);
    }
  }

  private requireRoomInfo(): RoomInfo {
    const roomInfo = this.stateManager.getRoomInfo();
    if (!roomInfo) {
      const error = new Error("Room not initialized");
      this.handleError(error);
      throw error;
    }

    return roomInfo;
  }

  private updateState(state: ConnectionState): void {
    this.stateManager.setState(state);
    this.events.emit("state", state);
    this.logDebug({
      type: "state",
      message: `State updated to ${state}`,
    });
  }

  private recordRemoteDescriptionCandidates(
    description: RTCSessionDescriptionInit | null
  ): void {
    if (!description?.sdp) {
      return;
    }

    for (const candidate of extractCandidatesFromSdp(description.sdp)) {
      this.remoteCandidateKeys.add(candidateKey(candidate));
    }
  }

  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.stateManager.setState(ConnectionState.ERROR);
    this.polling = false;
    this.events.emit("error", err);
    this.logDebug({
      type: "error",
      message: err.message,
    });
  }

  private logDebug(event: DebugEvent): void {
    this.events.emit("debug", event);
  }
}

function candidateKey(candidate: RTCIceCandidateInit): string {
  const mid = candidate.sdpMid ?? "";
  const line = candidate.sdpMLineIndex ?? -1;
  return `${candidate.candidate}|${mid}|${line}`;
}

function extractCandidatesFromSdp(sdp: string): RTCIceCandidateInit[] {
  const candidates: RTCIceCandidateInit[] = [];
  const lines = sdp.split(/\r?\n/);
  let currentMLineIndex = -1;
  let currentMid: string | undefined;

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith("m=")) {
      currentMLineIndex += 1;
      currentMid = undefined;
      continue;
    }

    if (line.startsWith("a=mid:")) {
      currentMid = line.substring("a=mid:".length);
      continue;
    }

    if (!line.startsWith("a=candidate:")) {
      continue;
    }

    const candidateLine = line.substring("a=".length);
    const candidate: RTCIceCandidateInit = {
      candidate: candidateLine,
    };

    if (currentMid !== undefined) {
      candidate.sdpMid = currentMid;
    } else if (currentMLineIndex >= 0) {
      candidate.sdpMLineIndex = currentMLineIndex;
    }

    candidates.push(candidate);
  }

  return candidates;
}

async function waitForIceGatheringComplete(
  pc: RTCPeerConnection
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      pc.removeEventListener("icegatheringstatechange", checkState);
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      resolve();
    };

    const checkState = () => {
      if (pc.iceGatheringState === "complete") {
        cleanup();
      }
    };

    timeout = setTimeout(() => {
      cleanup();
    }, 2000);

    pc.addEventListener("icegatheringstatechange", checkState);
  });
}

function descriptionToInit(
  description: RTCSessionDescription | null,
  fallback: RTCSessionDescriptionInit
): RTCSessionDescriptionInit {
  if (!description) {
    return fallback;
  }

  return {
    type: description.type,
    sdp: description.sdp,
  };
}

