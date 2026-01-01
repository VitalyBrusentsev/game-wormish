import { ConnectionState } from "./types";
import type {
  IRoomManager,
  IRegistryClient,
  IWebRTCManager,
  IStateManager,
  RoomInfo,
  DebugEvent,
} from "./types";

/**
 * Room Manager orchestrates the complete WebRTC connection lifecycle
 * 
 * Responsibilities:
 * - Room creation and joining
 * - Offer/answer exchange via Registry API
 * - ICE candidate exchange with efficient polling
 * - State transition management
 * - Data channel message handling
 */
export class RoomManager implements IRoomManager {
  private stateChangeCallbacks: ((state: ConnectionState) => void)[] = [];
  private messageCallbacks: ((message: any) => void)[] = [];
  private pollingInterval: number | null = null;
  private candidatePollingInterval: number | null = null;
  private processedCandidates = new Set<string>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit>();
  private debugCallbacks: ((event: DebugEvent) => void)[] = [];
  private peerConnectionState: RTCPeerConnectionState | null = null;
  private disconnectedTimer: number | null = null;

  constructor(
    private readonly registryClient: IRegistryClient,
    private readonly webRTCManager: IWebRTCManager,
    private readonly stateManager: IStateManager,
    private readonly iceServers: RTCIceServer[]
  ) {}

  /**
   * Create a new room as host
   * @param hostUserName - The host's username
   */
  async createRoom(hostUserName: string): Promise<RoomInfo> {
    this.setState(ConnectionState.CREATING);

    const response = await this.registryClient.createRoom(hostUserName);

    const roomInfo: RoomInfo = {
      code: response.code,
      joinCode: response.joinCode,
      hostUserName,
      role: "host",
      token: response.ownerToken,
      expiresAt: response.expiresAt,
    };

    this.stateManager.setRoomInfo(roomInfo);
    this.setState(ConnectionState.CREATED);

    return roomInfo;
  }

  /**
   * Join an existing room as guest
   * @param roomCode - The room code
   * @param joinCode - The join code
   * @param guestUserName - The guest's username
   */
  async joinRoom(
    roomCode: string,
    joinCode: string,
    guestUserName: string
  ): Promise<RoomInfo> {
    this.setState(ConnectionState.JOINING);

    // Get public room info first
    const publicInfo = await this.registryClient.getPublicRoomInfo(roomCode);

    // Join the room
    const response = await this.registryClient.joinRoom(roomCode, joinCode, guestUserName);

    const roomInfo: RoomInfo = {
      code: roomCode,
      hostUserName: publicInfo.hostUserName,
      guestUserName,
      role: "guest",
      token: response.guestToken,
      expiresAt: response.expiresAt,
    };

    this.stateManager.setRoomInfo(roomInfo);
    this.setState(ConnectionState.JOINED);

    return roomInfo;
  }

  /**
   * Start the WebRTC connection process
   */
  async startConnection(): Promise<void> {
    const roomInfo = this.stateManager.getRoomInfo();
    if (!roomInfo) {
      throw new Error("No room info available");
    }

    this.setState(ConnectionState.CONNECTING);
    this.processedCandidates.clear();
    this.pendingCandidates.clear();

    // Create peer connection
    const pc = this.webRTCManager.createPeerConnection(this.iceServers);
    this.stateManager.setPeerConnection(pc);

    // Set up ICE candidate handler
    this.webRTCManager.onIceCandidate(async (candidate) => {
      const candidateKey = this.getCandidateKey(candidate);
      try {
        await this.registryClient.postCandidate(roomInfo.code, roomInfo.token, candidate);
        this.emitDebug({
          type: "candidate-sent",
          candidateKey,
          candidate: candidate.candidate ?? "",
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("Failed to post ICE candidate:", error);
        this.emitDebug({
          type: "candidate-error",
          candidateKey,
          candidate: candidate.candidate ?? "",
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      }
    });

    // Set up connection state change handler
    this.webRTCManager.onConnectionStateChange((state) => {
      this.peerConnectionState = state;
      this.emitDebug({
        type: "peer-connection-state",
        state,
        timestamp: Date.now(),
      });

      const currentState = this.stateManager.getState();

      switch (state) {
        case "connected":
          if (this.disconnectedTimer !== null) {
            clearTimeout(this.disconnectedTimer);
            this.disconnectedTimer = null;
          }
          if (currentState === ConnectionState.DISCONNECTED) {
            const channel = this.stateManager.getDataChannel();
            if (channel && channel.readyState === "open") {
              this.setState(ConnectionState.CONNECTED);
            }
          }
          this.stopPolling();
          break;
        case "disconnected":
          if (currentState === ConnectionState.ERROR) break;
          if (this.disconnectedTimer !== null) break;
          this.disconnectedTimer = setTimeout(() => {
            this.disconnectedTimer = null;
            const channel = this.stateManager.getDataChannel();
            if (channel && channel.readyState === "open") return;
            if (this.peerConnectionState !== "disconnected") return;
            const latestState = this.stateManager.getState();
            if (latestState !== ConnectionState.ERROR) {
              this.setState(ConnectionState.DISCONNECTED);
            }
          }, 2500);
          break;
        case "failed":
          if (this.disconnectedTimer !== null) {
            clearTimeout(this.disconnectedTimer);
            this.disconnectedTimer = null;
          }
          this.stopPolling();
          this.emitDebug({
            type: "peer-connection-error",
            state,
            reason: "Peer connection failed",
            timestamp: Date.now(),
          });
          this.setState(ConnectionState.ERROR);
          break;
        case "closed":
          if (this.disconnectedTimer !== null) {
            clearTimeout(this.disconnectedTimer);
            this.disconnectedTimer = null;
          }
          if (currentState === ConnectionState.IDLE || currentState === ConnectionState.ERROR) {
            break;
          }
          this.stopPolling();
          this.emitDebug({
            type: "peer-connection-error",
            state,
            reason: "Peer connection closed unexpectedly",
            timestamp: Date.now(),
          });
          this.setState(ConnectionState.ERROR);
          break;
      }
    });

    if (roomInfo.role === "host") {
      await this.handleHostConnection(roomInfo);
    } else {
      await this.handleGuestConnection(roomInfo);
    }
  }

  /**
   * Handle host-side connection setup
   */
  private async handleHostConnection(roomInfo: RoomInfo): Promise<void> {
    // Create data channel (host creates it)
    const channel = this.webRTCManager.createDataChannel("game-data");
    this.setupDataChannel(channel);

    // Create and post offer
    const offer = await this.webRTCManager.createOffer();
    await this.webRTCManager.setLocalDescription(offer);
    await this.registryClient.postOffer(roomInfo.code, roomInfo.token, offer);
    this.emitDebug({ type: "offer-posted", timestamp: Date.now() });

    // Start polling for answer and candidates
    this.startPolling(roomInfo);
  }

  /**
   * Handle guest-side connection setup
   */
  private async handleGuestConnection(roomInfo: RoomInfo): Promise<void> {
    // Set up handler for receiving data channel from host
    this.webRTCManager.onDataChannel((channel) => {
      this.setupDataChannel(channel);
    });

    // Start polling for offer first
    this.startPolling(roomInfo);
  }

  /**
   * Set up data channel event handlers
   */
  private setupDataChannel(channel: RTCDataChannel): void {
    this.stateManager.setDataChannel(channel);
    this.emitDebug({
      type: "data-channel-state",
      state: channel.readyState,
      label: channel.label,
      timestamp: Date.now(),
    });

    channel.onopen = () => {
      this.setState(ConnectionState.CONNECTED);
      this.stopPolling();
      this.emitDebug({
        type: "data-channel-state",
        state: channel.readyState,
        label: channel.label,
        timestamp: Date.now(),
      });
    };

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.messageCallbacks.forEach((cb) => cb(message));
      } catch (error) {
        console.error("Failed to parse message:", error);
      }
    };

    channel.onclose = () => {
      if (this.stateManager.getState() !== ConnectionState.ERROR) {
        this.setState(ConnectionState.DISCONNECTED);
      }
      this.emitDebug({
        type: "data-channel-state",
        state: channel.readyState,
        label: channel.label,
        timestamp: Date.now(),
      });
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
    };
  }

  /**
   * Start polling for room state and candidates
   */
  private startPolling(roomInfo: RoomInfo): void {
    // Poll room state
    this.pollingInterval = window.setInterval(async () => {
      try {
        const snapshot = await this.registryClient.getRoom(roomInfo.code, roomInfo.token);
        this.emitDebug({
          type: "room-snapshot",
          status: snapshot.status,
          hasOffer: Boolean(snapshot.offer),
          hasAnswer: Boolean(snapshot.answer),
          timestamp: snapshot.updatedAt ?? Date.now(),
        });

        const peerConnection = this.stateManager.getPeerConnection();

        // Handle offer (guest side)
        if (roomInfo.role === "guest" && snapshot.offer && !peerConnection?.remoteDescription) {
          const answer = await this.webRTCManager.createAnswer(snapshot.offer);
          this.emitDebug({
            type: "remote-description-set",
            descriptionType: "offer",
            timestamp: Date.now(),
          });
          await this.webRTCManager.setLocalDescription(answer);
          await this.registryClient.postAnswer(roomInfo.code, roomInfo.token, answer);
          this.emitDebug({ type: "answer-posted", timestamp: Date.now() });
          await this.flushPendingCandidates(this.stateManager.getPeerConnection());
        }

        // Handle answer (host side)
        if (roomInfo.role === "host" && snapshot.answer && !peerConnection?.remoteDescription) {
          await this.webRTCManager.setRemoteDescription(snapshot.answer);
          this.emitDebug({
            type: "remote-description-set",
            descriptionType: "answer",
            timestamp: Date.now(),
          });
          await this.flushPendingCandidates(this.stateManager.getPeerConnection());
        }

        // Stop polling if room is closed. Once paired we can stop room polling
        // but keep candidate polling active until the data channel opens.
        if (snapshot.status === "closed") {
          this.stopPolling();
        } else if (snapshot.status === "paired") {
          this.stopRoomPolling();
        }
      } catch (error) {
        console.error("Error polling room state:", error);
      }
    }, 1000);

    // Poll for candidates
    this.candidatePollingInterval = window.setInterval(async () => {
      try {
        const candidateList = await this.registryClient.getCandidates(roomInfo.code, roomInfo.token);
        const peerConnection = this.stateManager.getPeerConnection();

        for (const candidate of candidateList.items) {
          const candidateKey = this.getCandidateKey(candidate);
          if (this.processedCandidates.has(candidateKey)) {
            continue;
          }

          if (!peerConnection || !peerConnection.remoteDescription) {
            if (!this.pendingCandidates.has(candidateKey)) {
              this.pendingCandidates.set(candidateKey, candidate);
              this.emitDebug({
                type: "candidate-buffered",
                candidateKey,
                candidate: candidate.candidate ?? "",
                timestamp: Date.now(),
              });
            }
            continue;
          }

          const applied = await this.applyCandidate(candidateKey, candidate);
          if (applied) {
            this.pendingCandidates.delete(candidateKey);
          }
        }

        await this.flushPendingCandidates(peerConnection ?? null);
      } catch (error) {
        console.error("Error polling candidates:", error);
      }
    }, 500);
  }

  /**
   * Generate a unique key for candidate deduplication
   */
  private getCandidateKey(candidate: RTCIceCandidateInit): string {
    return `${candidate.candidate || ""}|${candidate.sdpMid || ""}|${candidate.sdpMLineIndex ?? -1}`;
  }

  private async flushPendingCandidates(peerConnection: RTCPeerConnection | null): Promise<void> {
    if (!peerConnection || !peerConnection.remoteDescription || this.pendingCandidates.size === 0) {
      return;
    }

    for (const [candidateKey, candidate] of Array.from(this.pendingCandidates.entries())) {
      if (this.processedCandidates.has(candidateKey)) {
        this.pendingCandidates.delete(candidateKey);
        continue;
      }

      const applied = await this.applyCandidate(candidateKey, candidate);
      if (applied) {
        this.pendingCandidates.delete(candidateKey);
      }
    }
  }

  private async applyCandidate(
    candidateKey: string,
    candidate: RTCIceCandidateInit
  ): Promise<boolean> {
    try {
      await this.webRTCManager.addIceCandidate(candidate);
      this.processedCandidates.add(candidateKey);
      this.emitDebug({
        type: "candidate-applied",
        candidateKey,
        candidate: candidate.candidate ?? "",
        timestamp: Date.now(),
      });
      return true;
    } catch (error) {
      console.error("Failed to add ICE candidate:", error);
      this.processedCandidates.add(candidateKey);
      this.emitDebug({
        type: "candidate-error",
        candidateKey,
        candidate: candidate.candidate ?? "",
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      return false;
    }
  }

  /**
   * Stop all polling
   */
  private stopPolling(): void {
    this.stopRoomPolling();
    this.stopCandidatePolling();
    this.pendingCandidates.clear();
  }

  /**
   * Stop room state polling
   */
  private stopRoomPolling(): void {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Stop candidate polling
   */
  private stopCandidatePolling(): void {
    if (this.candidatePollingInterval !== null) {
      clearInterval(this.candidatePollingInterval);
      this.candidatePollingInterval = null;
    }
  }

  /**
   * Close the room and clean up resources
   */
  async closeRoom(): Promise<void> {
    const roomInfo = this.stateManager.getRoomInfo();
    if (roomInfo) {
      try {
        await this.registryClient.closeRoom(roomInfo.code, roomInfo.token);
      } catch (error) {
        console.error("Failed to close room:", error);
      }
    }

    this.stopPolling();
    this.stateManager.reset();
    this.processedCandidates.clear();
    this.pendingCandidates.clear();
    if (this.disconnectedTimer !== null) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
    this.setState(ConnectionState.IDLE);
  }

  /**
   * Send a message through the data channel
   */
  sendMessage(message: any): void {
    const channel = this.stateManager.getDataChannel();
    if (!channel || channel.readyState !== "open") {
      throw new Error("Data channel is not open");
    }

    channel.send(JSON.stringify(message));
  }

  /**
   * Register a state change callback
   */
  onStateChange(callback: (state: ConnectionState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  /**
   * Register a message callback
   */
  onMessage(callback: (message: any) => void): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Register a debug event callback
   */
  onDebugEvent(callback: (event: DebugEvent) => void): void {
    this.debugCallbacks.push(callback);
  }

  /**
   * Get the current connection state
   */
  getConnectionState(): ConnectionState {
    return this.stateManager.getState();
  }

  /**
   * Get the current room info
   */
  getRoomInfo(): RoomInfo | null {
    return this.stateManager.getRoomInfo();
  }

  /**
   * Update state and notify callbacks
   */
  private setState(state: ConnectionState): void {
    this.stateManager.setState(state);
    this.stateChangeCallbacks.forEach((cb) => cb(state));
  }

  private emitDebug(event: DebugEvent): void {
    this.debugCallbacks.forEach((cb) => cb(event));
  }
}
