import type { IWebRTCManager } from "./types";

/**
 * WebRTC Manager for handling peer connections and data channels
 * 
 * Manages:
 * - RTCPeerConnection lifecycle
 * - SDP offer/answer creation
 * - Local/remote description handling
 * - ICE candidate management
 * - Data channel creation and handling
 */
export class WebRTCManager implements IWebRTCManager {
  private peerConnection: RTCPeerConnection | null = null;
  private iceCandidateCallback: ((candidate: RTCIceCandidateInit) => void) | null = null;
  private connectionStateCallback: ((state: RTCPeerConnectionState) => void) | null = null;
  private dataChannelCallback: ((channel: RTCDataChannel) => void) | null = null;

  /**
   * Creates a new RTCPeerConnection with the specified ICE servers
   * @param iceServers - Array of ICE/STUN/TURN servers
   */
  createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
    this.peerConnection = new RTCPeerConnection({ iceServers });

    // Set up ICE candidate handler
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.iceCandidateCallback) {
        const candidate = event.candidate.toJSON();
        if (candidate.candidate && candidate.candidate.trim() !== "") {
          this.iceCandidateCallback(candidate);
        }
      }
    };

    // Set up connection state change handler
    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection && this.connectionStateCallback) {
        this.connectionStateCallback(this.peerConnection.connectionState);
      }
    };

    // Set up data channel handler (for guest receiving channel from host)
    this.peerConnection.ondatachannel = (event) => {
      if (this.dataChannelCallback) {
        this.dataChannelCallback(event.channel);
      }
    };

    return this.peerConnection;
  }

  /**
   * Creates an SDP offer
   * @param options - Optional offer options
   */
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    const offer = await this.peerConnection.createOffer(options);
    // Ensure the offer has the correct type field
    return {
      type: "offer",
      sdp: offer.sdp || ""
    };
  }

  /**
   * Creates an SDP answer for the given offer
   * @param offer - The remote offer
   * @param options - Optional answer options
   */
  async createAnswer(
    offer: RTCSessionDescriptionInit,
    options?: RTCAnswerOptions
  ): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    // Set remote description first
    await this.peerConnection.setRemoteDescription(offer);
    
    // Create answer
    const answer = await this.peerConnection.createAnswer(options);
    // Ensure the answer has the correct type field
    return {
      type: "answer",
      sdp: answer.sdp || ""
    };
  }

  /**
   * Sets the local description
   * @param description - The SDP description (offer or answer)
   */
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    await this.peerConnection.setLocalDescription(description);
  }

  /**
   * Sets the remote description
   * @param description - The SDP description (offer or answer)
   */
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    await this.peerConnection.setRemoteDescription(description);
  }

  /**
   * Adds an ICE candidate to the peer connection
   * @param candidate - The ICE candidate
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    // Guard against empty or invalid candidates
    if (!candidate.candidate || candidate.candidate.trim() === "") {
      return;
    }

    await this.peerConnection.addIceCandidate(candidate);
  }

  /**
   * Creates a data channel (host side)
   * @param label - The channel label
   * @param dataChannelDict - Optional channel configuration
   */
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): RTCDataChannel {
    if (!this.peerConnection) {
      throw new Error("Peer connection not initialized");
    }

    return this.peerConnection.createDataChannel(label, dataChannelDict);
  }

  /**
   * Registers a callback for ICE candidate events
   * @param callback - Function to call when a new ICE candidate is generated
   */
  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void {
    this.iceCandidateCallback = callback;
  }

  /**
   * Registers a callback for connection state changes
   * @param callback - Function to call when connection state changes
   */
  onConnectionStateChange(callback: (state: RTCPeerConnectionState) => void): void {
    this.connectionStateCallback = callback;
  }

  /**
   * Registers a callback for incoming data channels (guest side)
   * @param callback - Function to call when a data channel is received
   */
  onDataChannel(callback: (channel: RTCDataChannel) => void): void {
    this.dataChannelCallback = callback;
  }
}