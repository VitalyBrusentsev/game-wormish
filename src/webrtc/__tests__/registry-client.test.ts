import { describe, it, expect, vi, beforeEach } from "vitest";
import { RegistryClient } from "../registry-client";
import type { IHttpClient } from "../types";

describe("RegistryClient", () => {
  let registryClient: RegistryClient;
  let mockHttpClient: IHttpClient;
  const baseUrl = "https://registry.test.com";

  beforeEach(() => {
    mockHttpClient = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registryClient = new RegistryClient(baseUrl, mockHttpClient);
  });

  describe("createRoom", () => {
    it("should create a room with host username", async () => {
      const mockResponse = {
        code: "ABCD1234",
        ownerToken: "token123",
        joinCode: "123456",
        expiresAt: 1234567890,
      };

      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await registryClient.createRoom("Alice");

      expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/rooms`, {
        hostUserName: "Alice",
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe("getPublicRoomInfo", () => {
    it("should get public room information", async () => {
      const mockResponse = {
        status: "open" as const,
        expiresAt: 1234567890,
        hostUserName: "Alice",
      };

      (mockHttpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await registryClient.getPublicRoomInfo("ABCD1234");

      expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/rooms/ABCD1234/public`);
      expect(result).toEqual(mockResponse);
    });
  });

  describe("joinRoom", () => {
    it("should join a room with join code and guest username", async () => {
      const mockResponse = {
        guestToken: "guestToken123",
        expiresAt: 1234567890,
      };

      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await registryClient.joinRoom("ABCD1234", "123456", "Bob");

      expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/rooms/ABCD1234/join`, {
        joinCode: "123456",
        guestUserName: "Bob",
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe("postOffer", () => {
    it("should post SDP offer with access token", async () => {
      const offer = {
        type: "offer" as const,
        sdp: "v=0...",
      };

      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await registryClient.postOffer("ABCD1234", "token123", offer);

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        `${baseUrl}/rooms/ABCD1234/offer`,
        offer,
        { "X-Access-Token": "token123" }
      );
    });
  });

  describe("postAnswer", () => {
    it("should post SDP answer with access token", async () => {
      const answer = {
        type: "answer" as const,
        sdp: "v=0...",
      };

      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await registryClient.postAnswer("ABCD1234", "token123", answer);

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        `${baseUrl}/rooms/ABCD1234/answer`,
        answer,
        { "X-Access-Token": "token123" }
      );
    });
  });

  describe("postCandidate", () => {
    it("should post ICE candidate with access token", async () => {
      const candidate = {
        candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      };

      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await registryClient.postCandidate("ABCD1234", "token123", candidate);

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        `${baseUrl}/rooms/ABCD1234/candidate`,
        candidate,
        { "X-Access-Token": "token123" }
      );
    });
  });

  describe("getRoom", () => {
    it("should get room snapshot with access token", async () => {
      const mockResponse = {
        status: "paired" as const,
        offer: { type: "offer" as const, sdp: "v=0..." },
        answer: { type: "answer" as const, sdp: "v=0..." },
        updatedAt: 1234567890,
        expiresAt: 1234567890,
      };

      (mockHttpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await registryClient.getRoom("ABCD1234", "token123");

      expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/rooms/ABCD1234`, {
        "X-Access-Token": "token123",
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe("getCandidates", () => {
    it("should get ICE candidates with access token", async () => {
      const mockResponse = {
        items: [
          {
            candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        ],
        mode: "full" as const,
      };

      (mockHttpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await registryClient.getCandidates("ABCD1234", "token123");

      expect(mockHttpClient.get).toHaveBeenCalledWith(
        `${baseUrl}/rooms/ABCD1234/candidates`,
        { "X-Access-Token": "token123" }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe("closeRoom", () => {
    it("should close the room with access token", async () => {
      (mockHttpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await registryClient.closeRoom("ABCD1234", "token123");

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        `${baseUrl}/rooms/ABCD1234/close`,
        undefined,
        { "X-Access-Token": "token123" }
      );
    });
  });
});