import { describe, it, expect, beforeEach } from "vitest";
import { StateManager } from "../state-manager";
import { ConnectionState } from "../types";
import type { RoomInfo } from "../types";

describe("StateManager", () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager();
  });

  describe("state management", () => {
    it("should initialize with IDLE state", () => {
      expect(stateManager.getState()).toBe(ConnectionState.IDLE);
    });

    it("should allow custom initial state", () => {
      const customStateManager = new StateManager(ConnectionState.CREATING);
      expect(customStateManager.getState()).toBe(ConnectionState.CREATING);
    });

    it("should update state", () => {
      stateManager.setState(ConnectionState.CONNECTED);
      expect(stateManager.getState()).toBe(ConnectionState.CONNECTED);
    });

    it("should transition through multiple states", () => {
      stateManager.setState(ConnectionState.CREATING);
      expect(stateManager.getState()).toBe(ConnectionState.CREATING);

      stateManager.setState(ConnectionState.CREATED);
      expect(stateManager.getState()).toBe(ConnectionState.CREATED);

      stateManager.setState(ConnectionState.CONNECTING);
      expect(stateManager.getState()).toBe(ConnectionState.CONNECTING);

      stateManager.setState(ConnectionState.CONNECTED);
      expect(stateManager.getState()).toBe(ConnectionState.CONNECTED);
    });
  });

  describe("room info management", () => {
    it("should initialize with null room info", () => {
      expect(stateManager.getRoomInfo()).toBeNull();
    });

    it("should store and retrieve room info", () => {
      const roomInfo: RoomInfo = {
        code: "ABCD1234",
        hostUserName: "Alice",
        role: "host",
        token: "token123",
        expiresAt: Date.now() + 60000,
      };

      stateManager.setRoomInfo(roomInfo);
      expect(stateManager.getRoomInfo()).toEqual(roomInfo);
    });

    it("should update room info", () => {
      const roomInfo1: RoomInfo = {
        code: "ABCD1234",
        role: "host",
        token: "token123",
        expiresAt: Date.now() + 60000,
      };

      const roomInfo2: RoomInfo = {
        code: "ABCD1234",
        hostUserName: "Alice",
        guestUserName: "Bob",
        role: "host",
        token: "token123",
        expiresAt: Date.now() + 60000,
      };

      stateManager.setRoomInfo(roomInfo1);
      expect(stateManager.getRoomInfo()).toEqual(roomInfo1);

      stateManager.setRoomInfo(roomInfo2);
      expect(stateManager.getRoomInfo()).toEqual(roomInfo2);
    });
  });

  describe("peer connection management", () => {
    it("should initialize with null peer connection", () => {
      expect(stateManager.getPeerConnection()).toBeNull();
    });

    it("should store and retrieve peer connection", () => {
      const mockPeerConnection = {} as RTCPeerConnection;
      stateManager.setPeerConnection(mockPeerConnection);
      expect(stateManager.getPeerConnection()).toBe(mockPeerConnection);
    });
  });

  describe("data channel management", () => {
    it("should initialize with null data channel", () => {
      expect(stateManager.getDataChannel()).toBeNull();
    });

    it("should store and retrieve data channel", () => {
      const mockDataChannel = {} as RTCDataChannel;
      stateManager.setDataChannel(mockDataChannel);
      expect(stateManager.getDataChannel()).toBe(mockDataChannel);
    });
  });

  describe("reset", () => {
    it("should reset state to IDLE", () => {
      stateManager.setState(ConnectionState.CONNECTED);
      stateManager.reset();
      expect(stateManager.getState()).toBe(ConnectionState.IDLE);
    });

    it("should clear room info", () => {
      const roomInfo: RoomInfo = {
        code: "ABCD1234",
        role: "host",
        token: "token123",
        expiresAt: Date.now() + 60000,
      };
      stateManager.setRoomInfo(roomInfo);
      stateManager.reset();
      expect(stateManager.getRoomInfo()).toBeNull();
    });

    it("should close and clear data channel", () => {
      const mockDataChannel = {
        close: () => {},
      } as RTCDataChannel;

      stateManager.setDataChannel(mockDataChannel);
      stateManager.reset();
      expect(stateManager.getDataChannel()).toBeNull();
    });

    it("should close and clear peer connection", () => {
      const mockPeerConnection = {
        close: () => {},
      } as RTCPeerConnection;

      stateManager.setPeerConnection(mockPeerConnection);
      stateManager.reset();
      expect(stateManager.getPeerConnection()).toBeNull();
    });

    it("should reset all state completely", () => {
      const roomInfo: RoomInfo = {
        code: "ABCD1234",
        role: "host",
        token: "token123",
        expiresAt: Date.now() + 60000,
      };
      const mockPeerConnection = { close: () => {} } as RTCPeerConnection;
      const mockDataChannel = { close: () => {} } as RTCDataChannel;

      stateManager.setState(ConnectionState.CONNECTED);
      stateManager.setRoomInfo(roomInfo);
      stateManager.setPeerConnection(mockPeerConnection);
      stateManager.setDataChannel(mockDataChannel);

      stateManager.reset();

      expect(stateManager.getState()).toBe(ConnectionState.IDLE);
      expect(stateManager.getRoomInfo()).toBeNull();
      expect(stateManager.getPeerConnection()).toBeNull();
      expect(stateManager.getDataChannel()).toBeNull();
    });
  });
});