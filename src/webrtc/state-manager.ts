import { ConnectionState } from "./types";
import type { IStateManager, RoomInfo } from "./types";

/**
 * State Manager for tracking connection lifecycle state
 * 
 * Manages:
 * - Connection state transitions
 * - Room information
 * - WebRTC peer connection reference
 * - Data channel reference
 */
export class StateManager implements IStateManager {
  private state: ConnectionState;
  private roomInfo: RoomInfo | null;
  private peerConnection: RTCPeerConnection | null;
  private dataChannel: RTCDataChannel | null;

  constructor(initialState: ConnectionState = ConnectionState.IDLE) {
    this.state = initialState;
    this.roomInfo = null;
    this.peerConnection = null;
    this.dataChannel = null;
  }

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

  setPeerConnection(connection: RTCPeerConnection): void {
    this.peerConnection = connection;
  }

  getDataChannel(): RTCDataChannel | null {
    return this.dataChannel;
  }

  setDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
  }

  reset(): void {
    this.state = ConnectionState.IDLE;
    this.roomInfo = null;
    
    // Close data channel if open
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    
    // Close peer connection if open
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
}