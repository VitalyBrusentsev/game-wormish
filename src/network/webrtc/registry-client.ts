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

type InternalEvents = Record<string, unknown> & {
  state: ConnectionState;
  message: unknown;
  error: Error;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;

const REGISTRY_VERSION_HEADER = "X-Registry-Version";
const REGISTRY_VERSION_VALUE = "1";

class DefaultHttpClient implements IHttpClient {
  async get(url: string, headers: Record<string, string> = {}): Promise<any> {
    const response = await fetch(url, {
      mode: "cors",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      credentials: "include",
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
      credentials: "include",
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
      withTokenHeaders(token)
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
      withTokenHeaders(token)
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
      withTokenHeaders(token)
    );
  }

  async getRoom(roomCode: string, token: string): Promise<RoomSnapshot> {
    return this.http.get(
      this.url(`/rooms/${roomCode}`),
      withTokenHeaders(token)
    );
  }

  async getCandidates(
    roomCode: string,
    token: string
  ): Promise<CandidateList> {
    return this.http.get(
      this.url(`/rooms/${roomCode}/candidates`),
      withTokenHeaders(token)
    );
  }

  async closeRoom(roomCode: string, token: string): Promise<void> {
    await this.http.post(
      this.url(`/rooms/${roomCode}/close`),
      undefined,
      withTokenHeaders(token)
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

  createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
    this.peerConnection = new RTCPeerConnection({ iceServers });
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.iceCallback) {
        this.iceCallback(event.candidate.toJSON());
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
    return offer;
  }

  async createAnswer(
    options?: RTCAnswerOptions
  ): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    const answer = await pc.createAnswer(options);
    await pc.setLocalDescription(answer);
    return answer;
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

function withTokenHeaders(token: string): Record<string, string> {
  return withCsrfHeader({
    "X-Access-Token": token,
  });
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

    const peerConnection = this.webRTCManager.createPeerConnection(
      this.config.iceServers
    );
    this.stateManager.setPeerConnection(peerConnection);

    const role = roomInfo.role;

    if (role === "host") {
      const dataChannel = this.webRTCManager.createDataChannel("game-data");
      this.setupDataChannel(dataChannel);
    } else {
      this.webRTCManager.onDataChannel((channel) => {
        this.setupDataChannel(channel);
      });
    }

    this.webRTCManager.onIceCandidate(async (candidate) => {
      try {
        await this.registryClient.postCandidate(
          roomInfo.code,
          roomInfo.token,
          candidate
        );
      } catch (error) {
        this.handleError(error);
      }
    });

    this.webRTCManager.onConnectionStateChange((state) => {
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
    };
    dataChannel.onclose = () => {
      if (!this.isClosing) {
        this.updateState(ConnectionState.DISCONNECTED);
      }
    };
    dataChannel.onmessage = (event) => {
      const parsed = typeof event.data === "string" ? parseMessage(event.data) : event.data;
      this.events.emit("message", parsed);
    };
  }

  private async handleHostConnection(roomInfo: RoomInfo): Promise<void> {
    const offer = await this.webRTCManager.createOffer();
    await this.registryClient.postOffer(roomInfo.code, roomInfo.token, offer);
    await this.waitForAnswer(roomInfo);
    this.startCandidateDrain(roomInfo);
  }

  private async handleGuestConnection(roomInfo: RoomInfo): Promise<void> {
    const offer = await this.waitForOffer(roomInfo);
    await this.webRTCManager.setRemoteDescription(offer);
    const answer = await this.webRTCManager.createAnswer();
    await this.registryClient.postAnswer(roomInfo.code, roomInfo.token, answer);
    this.startCandidateDrain(roomInfo);
  }

  private async waitForAnswer(roomInfo: RoomInfo): Promise<void> {
    this.polling = true;
    while (!this.isClosing) {
      const snapshot = await this.registryClient.getRoom(
        roomInfo.code,
        roomInfo.token
      );
      if (snapshot.answer) {
        await this.webRTCManager.setRemoteDescription(snapshot.answer);
        this.polling = false;
        return;
      }
      await wait(this.pollIntervalMs);
    }
  }

  private async waitForOffer(roomInfo: RoomInfo): Promise<RTCSessionDescriptionInit> {
    this.polling = true;
    while (!this.isClosing) {
      const snapshot = await this.registryClient.getRoom(
        roomInfo.code,
        roomInfo.token
      );
      if (snapshot.offer) {
        this.polling = false;
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

    void this.drainRemoteCandidates(roomInfo);
  }

  private async drainRemoteCandidates(roomInfo: RoomInfo): Promise<void> {
    while (!this.isClosing) {
      try {
        const candidateList = await this.registryClient.getCandidates(
          roomInfo.code,
          roomInfo.token
        );
        for (const candidate of candidateList.items) {
          const key = candidateKey(candidate);
          if (!this.remoteCandidateKeys.has(key)) {
            this.remoteCandidateKeys.add(key);
            await this.webRTCManager.addIceCandidate(candidate);
          }
        }
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
  }

  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.stateManager.setState(ConnectionState.ERROR);
    this.polling = false;
    this.events.emit("error", err);
  }
}

function candidateKey(candidate: RTCIceCandidateInit): string {
  const mid = candidate.sdpMid ?? "";
  const line = candidate.sdpMLineIndex ?? -1;
  return `${candidate.candidate}|${mid}|${line}`;
}

