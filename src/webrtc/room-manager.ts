import { ConnectionState } from "./types";
import type {
  IRoomManager,
  IRegistryClient,
  IWebRTCManager,
  IStateManager,
  RoomInfo,
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

    // Create peer connection
    const pc = this.webRTCManager.createPeerConnection(this.iceServers);
    this.stateManager.setPeerConnection(pc);

    // Set up ICE candidate handler
    this.webRTCManager.onIceCandidate(async (candidate) => {
      try {
        await this.registryClient.postCandidate(roomInfo.code, roomInfo.token, candidate);
      } catch (error) {
        console.error("Failed to post ICE candidate:", error);
      }
    });

    // Set up connection state change handler
    this.webRTCManager.onConnectionStateChange((state) => {
      if (state === "connected") {
        this.stopPolling();
      } else if (state === "failed" || state === "closed") {
        this.stopPolling();
        this.setState(ConnectionState.DISCONNECTED);
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

    channel.onopen = () => {
      this.setState(ConnectionState.CONNECTED);
      this.stopPolling();
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
      this.setState(ConnectionState.DISCONNECTED);
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

        // Handle offer (guest side)
        if (roomInfo.role === "guest" && snapshot.offer && !this.stateManager.getPeerConnection()?.remoteDescription) {
          const answer = await this.webRTCManager.createAnswer(snapshot.offer);
          await this.webRTCManager.setLocalDescription(answer);
          await this.registryClient.postAnswer(roomInfo.code, roomInfo.token, answer);
        }

        // Handle answer (host side)
        if (roomInfo.role === "host" && snapshot.answer && !this.stateManager.getPeerConnection()?.remoteDescription) {
          await this.webRTCManager.setRemoteDescription(snapshot.answer);
        }

        // Stop polling if room is closed or paired
        if (snapshot.status === "closed" || snapshot.status === "paired") {
          this.stopPolling();
        }
      } catch (error) {
        console.error("Error polling room state:", error);
      }
    }, 1000);

    // Poll for candidates
    this.candidatePollingInterval = window.setInterval(async () => {
      try {
        const candidateList = await this.registryClient.getCandidates(roomInfo.code, roomInfo.token);
        
        for (const candidate of candidateList.items) {
          // Idempotent candidate handling - deduplicate using candidate string
          const candidateKey = this.getCandidateKey(candidate);
          if (!this.processedCandidates.has(candidateKey)) {
            this.processedCandidates.add(candidateKey);
            await this.webRTCManager.addIceCandidate(candidate);
          }
        }

        // Check if ICE gathering is complete
        const pc = this.stateManager.getPeerConnection();
        if (pc && pc.iceGatheringState === "complete") {
          this.stopCandidatePolling();
        }
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

  /**
   * Stop all polling
   */
  private stopPolling(): void {
    this.stopRoomPolling();
    this.stopCandidatePolling();
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
}