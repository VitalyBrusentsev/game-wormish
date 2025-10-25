import { ConnectionState } from "./types";
import type {
  IWebRTCRegistryClient,
  WebRTCClientConfig,
  RoomInfo,
  IHttpClient,
  IWebRTCManager,
  IStateManager,
  IRoomManager,
} from "./types";
import { HttpClient } from "./http-client";
import { RegistryClient } from "./registry-client";
import { StateManager } from "./state-manager";
import { WebRTCManager } from "./webrtc-manager";
import { RoomManager } from "./room-manager";

/**
 * Main WebRTC Registry Client
 * 
 * High-level API for establishing peer-to-peer WebRTC connections
 * using the Cloudflare Registry API for signaling.
 * 
 * Features:
 * - Room creation (host) and joining (guest)
 * - Automatic SDP and ICE candidate exchange
 * - State management and event notifications
 * - Data channel messaging
 */
export class WebRTCRegistryClient implements IWebRTCRegistryClient {
  private readonly roomManager: IRoomManager;
  private errorCallbacks: ((error: Error) => void)[] = [];

  constructor(config: WebRTCClientConfig) {
    // Use injected dependencies or create defaults
    const httpClient: IHttpClient = config.httpClient || new HttpClient();
    const registryClient = new RegistryClient(config.registryApiUrl, httpClient);
    const webRTCManager: IWebRTCManager = config.webRTCManager || new WebRTCManager();
    const stateManager: IStateManager = config.stateManager || new StateManager();

    // Create room manager
    this.roomManager = new RoomManager(
      registryClient,
      webRTCManager,
      stateManager,
      config.iceServers
    );

    // Set up error handling wrapper
    this.wrapRoomManagerForErrors();
  }

  /**
   * Create a new room as host
   * @param hostUserName - The host's username
   * @returns The room code to share with the guest
   */
  async createRoom(hostUserName: string): Promise<string> {
    try {
      const roomInfo = await this.roomManager.createRoom(hostUserName);
      return roomInfo.code;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Join an existing room as guest
   * @param roomCode - The room code provided by host
   * @param joinCode - The join code provided by host
   * @param guestUserName - The guest's username
   */
  async joinRoom(roomCode: string, joinCode: string, guestUserName: string): Promise<void> {
    try {
      await this.roomManager.joinRoom(roomCode, joinCode, guestUserName);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Start the WebRTC connection process
   * Call this after creating or joining a room
   */
  async startConnection(): Promise<void> {
    try {
      await this.roomManager.startConnection();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Send a message through the data channel
   * @param message - Any JSON-serializable message
   */
  sendMessage(message: any): void {
    try {
      this.roomManager.sendMessage(message);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Close the room and clean up resources
   */
  async closeRoom(): Promise<void> {
    try {
      await this.roomManager.closeRoom();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Register a callback for state changes
   * @param callback - Function to call when connection state changes
   */
  onStateChange(callback: (state: ConnectionState) => void): void {
    this.roomManager.onStateChange(callback);
  }

  /**
   * Register a callback for incoming messages
   * @param callback - Function to call when a message is received
   */
  onMessage(callback: (message: any) => void): void {
    this.roomManager.onMessage(callback);
  }

  /**
   * Register a callback for errors
   * @param callback - Function to call when an error occurs
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Get the current connection state
   */
  getConnectionState(): ConnectionState {
    return this.roomManager.getConnectionState();
  }

  /**
   * Get the current room information
   */
  getRoomInfo(): RoomInfo | null {
    return this.roomManager.getRoomInfo();
  }

  /**
   * Handle errors by notifying registered callbacks
   */
  private handleError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.errorCallbacks.forEach((cb) => cb(err));
  }

  /**
   * Wrap room manager methods to catch and report errors
   */
  private wrapRoomManagerForErrors(): void {
    // State changes to ERROR state should also trigger error callbacks
    this.roomManager.onStateChange((state) => {
      if (state === ConnectionState.ERROR) {
        this.handleError(new Error("Connection entered error state"));
      }
    });
  }
}