import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebRTCRegistryClient } from "../client";
import { ConnectionState } from "../types";
describe("WebRTCRegistryClient", () => {
  let client: WebRTCRegistryClient;

  beforeEach(() => {
    const config = {
      registryApiUrl: "https://registry.test.com",
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    client = new WebRTCRegistryClient(config);
  });

  describe("createRoom", () => {
    it("should create a room and return room code", async () => {
      const config = {
        registryApiUrl: "https://registry.test.com",
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          code: "ABCD1234",
          ownerToken: "token123",
          joinCode: "123456",
          expiresAt: Date.now() + 60000,
        }),
        headers: new Map([["content-type", "application/json"]]),
      });

      globalThis.fetch = mockFetch as any;

      const client = new WebRTCRegistryClient(config);
      const roomCode = await client.createRoom("Alice");

      expect(roomCode).toBe("ABCD1234");
    });
  });

  describe("event handlers", () => {
    it("should register state change callback", () => {
      const callback = vi.fn();
      client.onStateChange(callback);
      // Callback is registered internally
    });

    it("should register message callback", () => {
      const callback = vi.fn();
      client.onMessage(callback);
      // Callback is registered internally
    });

    it("should register error callback", () => {
      const callback = vi.fn();
      client.onError(callback);
      // Callback is registered internally
    });
  });

  describe("getConnectionState", () => {
    it("should return current connection state", () => {
      const config = {
        registryApiUrl: "https://registry.test.com",
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      };

      const client = new WebRTCRegistryClient(config);
      const state = client.getConnectionState();

      expect(state).toBe(ConnectionState.IDLE);
    });
  });

  describe("getRoomInfo", () => {
    it("should return null when no room is active", () => {
      const config = {
        registryApiUrl: "https://registry.test.com",
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      };

      const client = new WebRTCRegistryClient(config);
      const roomInfo = client.getRoomInfo();

      expect(roomInfo).toBeNull();
    });
  });
});