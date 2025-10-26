import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebRTCManager } from "../webrtc-manager";

describe("WebRTCManager", () => {
  let webRTCManager: WebRTCManager;
  let mockPeerConnection: any;

  beforeEach(() => {
    webRTCManager = new WebRTCManager();

    // Mock RTCPeerConnection
    mockPeerConnection = {
      createOffer: vi.fn(),
      createAnswer: vi.fn(),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
      addIceCandidate: vi.fn(),
      createDataChannel: vi.fn(),
      close: vi.fn(),
      onicecandidate: null,
      onconnectionstatechange: null,
      ondatachannel: null,
      connectionState: "new",
      iceGatheringState: "new",
      remoteDescription: null,
    };
  });

  describe("createPeerConnection", () => {
    it("should create a peer connection with ICE servers", () => {
      const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;

      const pc = webRTCManager.createPeerConnection(iceServers);

      expect(globalThis.RTCPeerConnection).toHaveBeenCalledWith({ iceServers });
      expect(pc).toBe(mockPeerConnection);
    });

    it("should set up ICE candidate handler", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const candidateCallback = vi.fn();

      webRTCManager.onIceCandidate(candidateCallback);
      webRTCManager.createPeerConnection([]);

      expect(mockPeerConnection.onicecandidate).toBeDefined();
    });

    it("should forward mDNS candidates", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const candidateCallback = vi.fn();

      webRTCManager.onIceCandidate(candidateCallback);
      webRTCManager.createPeerConnection([]);

      // Simulate mDNS candidate
      const mdnsCandidate = {
        candidate: "candidate:1 1 UDP 2130706431 hostname.local 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        toJSON: function () {
          return {
            candidate: this.candidate,
            sdpMid: this.sdpMid,
            sdpMLineIndex: this.sdpMLineIndex,
          };
        },
      };

      mockPeerConnection.onicecandidate({ candidate: mdnsCandidate });

      expect(candidateCallback).toHaveBeenCalledWith({
        candidate: mdnsCandidate.candidate,
        sdpMid: mdnsCandidate.sdpMid,
        sdpMLineIndex: mdnsCandidate.sdpMLineIndex,
      });
    });

    it("should pass valid candidates to callback", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const candidateCallback = vi.fn();

      webRTCManager.onIceCandidate(candidateCallback);
      webRTCManager.createPeerConnection([]);

      const validCandidate = {
        candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        toJSON: function () {
          return {
            candidate: this.candidate,
            sdpMid: this.sdpMid,
            sdpMLineIndex: this.sdpMLineIndex,
          };
        },
      };

      mockPeerConnection.onicecandidate({ candidate: validCandidate });

      expect(candidateCallback).toHaveBeenCalledWith({
        candidate: validCandidate.candidate,
        sdpMid: validCandidate.sdpMid,
        sdpMLineIndex: validCandidate.sdpMLineIndex,
      });
    });

    it("should set up connection state change handler", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const stateCallback = vi.fn();

      webRTCManager.onConnectionStateChange(stateCallback);
      webRTCManager.createPeerConnection([]);

      mockPeerConnection.connectionState = "connected";
      mockPeerConnection.onconnectionstatechange();

      expect(stateCallback).toHaveBeenCalledWith("connected");
    });

    it("should set up data channel handler", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const dataChannelCallback = vi.fn();

      webRTCManager.onDataChannel(dataChannelCallback);
      webRTCManager.createPeerConnection([]);

      const mockChannel = {} as RTCDataChannel;
      mockPeerConnection.ondatachannel({ channel: mockChannel });

      expect(dataChannelCallback).toHaveBeenCalledWith(mockChannel);
    });
  });

  describe("createOffer", () => {
    it("should create an SDP offer", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const mockOffer = { type: "offer" as const, sdp: "v=0..." };
      mockPeerConnection.createOffer.mockResolvedValue(mockOffer);

      webRTCManager.createPeerConnection([]);
      const offer = await webRTCManager.createOffer();

      expect(mockPeerConnection.createOffer).toHaveBeenCalled();
      expect(offer).toEqual(mockOffer);
    });

    it("should throw error if peer connection not initialized", async () => {
      await expect(webRTCManager.createOffer()).rejects.toThrow(
        "Peer connection not initialized"
      );
    });

    it("should pass options to createOffer", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      mockPeerConnection.createOffer.mockResolvedValue({ type: "offer" as const, sdp: "v=0..." });

      webRTCManager.createPeerConnection([]);
      const options = { offerToReceiveAudio: true };
      await webRTCManager.createOffer(options);

      expect(mockPeerConnection.createOffer).toHaveBeenCalledWith(options);
    });
  });

  describe("createAnswer", () => {
    it("should set remote description and create answer", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const mockOffer = { type: "offer" as const, sdp: "v=0..." };
      const mockAnswer = { type: "answer" as const, sdp: "v=0..." };

      mockPeerConnection.setRemoteDescription.mockResolvedValue(undefined);
      mockPeerConnection.createAnswer.mockResolvedValue(mockAnswer);

      webRTCManager.createPeerConnection([]);
      const answer = await webRTCManager.createAnswer(mockOffer);

      expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalledWith(mockOffer);
      expect(mockPeerConnection.createAnswer).toHaveBeenCalled();
      expect(answer).toEqual(mockAnswer);
    });

    it("should throw error if peer connection not initialized", async () => {
      const mockOffer = { type: "offer" as const, sdp: "v=0..." };
      await expect(webRTCManager.createAnswer(mockOffer)).rejects.toThrow(
        "Peer connection not initialized"
      );
    });
  });

  describe("setLocalDescription", () => {
    it("should set local description", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const description = { type: "offer" as const, sdp: "v=0..." };
      mockPeerConnection.setLocalDescription.mockResolvedValue(undefined);

      webRTCManager.createPeerConnection([]);
      await webRTCManager.setLocalDescription(description);

      expect(mockPeerConnection.setLocalDescription).toHaveBeenCalledWith(description);
    });

    it("should throw error if peer connection not initialized", async () => {
      const description = { type: "offer" as const, sdp: "v=0..." };
      await expect(webRTCManager.setLocalDescription(description)).rejects.toThrow(
        "Peer connection not initialized"
      );
    });
  });

  describe("setRemoteDescription", () => {
    it("should set remote description", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const description = { type: "answer" as const, sdp: "v=0..." };
      mockPeerConnection.setRemoteDescription.mockResolvedValue(undefined);

      webRTCManager.createPeerConnection([]);
      await webRTCManager.setRemoteDescription(description);

      expect(mockPeerConnection.setRemoteDescription).toHaveBeenCalledWith(description);
    });

    it("should throw error if peer connection not initialized", async () => {
      const description = { type: "answer" as const, sdp: "v=0..." };
      await expect(webRTCManager.setRemoteDescription(description)).rejects.toThrow(
        "Peer connection not initialized"
      );
    });
  });

  describe("addIceCandidate", () => {
    it("should add ICE candidate", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const candidate = {
        candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };
      mockPeerConnection.addIceCandidate.mockResolvedValue(undefined);

      webRTCManager.createPeerConnection([]);
      await webRTCManager.addIceCandidate(candidate);

      expect(mockPeerConnection.addIceCandidate).toHaveBeenCalledWith(candidate);
    });

    it("should ignore empty candidates", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const emptyCandidate = { candidate: "", sdpMid: "0", sdpMLineIndex: 0 };

      webRTCManager.createPeerConnection([]);
      await webRTCManager.addIceCandidate(emptyCandidate);

      expect(mockPeerConnection.addIceCandidate).not.toHaveBeenCalled();
    });

    it("should ignore whitespace-only candidates", async () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const whitespaceCandidate = { candidate: "   ", sdpMid: "0", sdpMLineIndex: 0 };

      webRTCManager.createPeerConnection([]);
      await webRTCManager.addIceCandidate(whitespaceCandidate);

      expect(mockPeerConnection.addIceCandidate).not.toHaveBeenCalled();
    });

    it("should throw error if peer connection not initialized", async () => {
      const candidate = {
        candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };
      await expect(webRTCManager.addIceCandidate(candidate)).rejects.toThrow(
        "Peer connection not initialized"
      );
    });
  });

  describe("createDataChannel", () => {
    it("should create a data channel", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const mockChannel = {} as RTCDataChannel;
      mockPeerConnection.createDataChannel.mockReturnValue(mockChannel);

      webRTCManager.createPeerConnection([]);
      const channel = webRTCManager.createDataChannel("test-channel");

      expect(mockPeerConnection.createDataChannel).toHaveBeenCalledWith("test-channel", undefined);
      expect(channel).toBe(mockChannel);
    });

    it("should create data channel with options", () => {
      globalThis.RTCPeerConnection = vi.fn(() => mockPeerConnection) as any;
      const mockChannel = {} as RTCDataChannel;
      mockPeerConnection.createDataChannel.mockReturnValue(mockChannel);

      webRTCManager.createPeerConnection([]);
      const options = { ordered: false };
      webRTCManager.createDataChannel("test-channel", options);

      expect(mockPeerConnection.createDataChannel).toHaveBeenCalledWith("test-channel", options);
    });

    it("should throw error if peer connection not initialized", () => {
      expect(() => webRTCManager.createDataChannel("test-channel")).toThrow(
        "Peer connection not initialized"
      );
    });
  });
});