import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpClient } from "../http-client";

describe("HttpClient", () => {
  let httpClient: HttpClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    httpClient = new HttpClient();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;
  });

  describe("get", () => {
    it("should perform a GET request with correct headers", async () => {
      const mockResponse = { data: "test" };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await httpClient.get("https://api.test.com/endpoint");

      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/endpoint", {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
        },
      });
      expect(result).toEqual(mockResponse);
    });

    it("should include custom headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await httpClient.get("https://api.test.com/endpoint", {
        "X-Custom-Header": "value",
      });

      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/endpoint", {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Header": "value",
        },
      });
    });

    it("should throw error on failed request", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({
          error: {
            code: "NOT_FOUND",
            message: "Resource not found",
            retryable: false,
          },
        }),
      });

      await expect(httpClient.get("https://api.test.com/endpoint")).rejects.toThrow(
        "Resource not found"
      );
    });

    it("should handle error with retry information", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({
          error: {
            code: "RATE_LIMIT",
            message: "Rate limit exceeded",
            retryable: true,
            retryAfterSec: 60,
          },
        }),
      });

      try {
        await httpClient.get("https://api.test.com/endpoint");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Rate limit exceeded");
        expect(error.code).toBe("RATE_LIMIT");
        expect(error.status).toBe(429);
        expect(error.retryable).toBe(true);
        expect(error.retryAfterSec).toBe(60);
      }
    });
  });

  describe("post", () => {
    it("should perform a POST request with CSRF header", async () => {
      const mockResponse = { success: true };
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => mockResponse,
      });

      const body = { data: "test" };
      const result = await httpClient.post("https://api.test.com/endpoint", body);

      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/endpoint", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Registry-Version": "1",
        },
        body: JSON.stringify(body),
      });
      expect(result).toEqual(mockResponse);
    });

    it("should include custom headers with CSRF header", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await httpClient.post(
        "https://api.test.com/endpoint",
        {},
        { "X-Access-Token": "token123" }
      );

      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/endpoint", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Registry-Version": "1",
          "X-Access-Token": "token123",
        },
        body: JSON.stringify({}),
      });
    });

    it("should handle POST without body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await httpClient.post("https://api.test.com/endpoint");

      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/endpoint", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Registry-Version": "1",
        },
        body: null,
      });
    });

    it("should handle 204 No Content response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map(),
      });

      const result = await httpClient.post("https://api.test.com/endpoint", {});

      expect(result).toBeUndefined();
    });

    it("should throw error on failed POST", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid request body",
            retryable: false,
          },
        }),
      });

      await expect(
        httpClient.post("https://api.test.com/endpoint", {})
      ).rejects.toThrow("Invalid request body");
    });
  });

  describe("error handling", () => {
    it("should handle malformed error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });

      try {
        await httpClient.get("https://api.test.com/endpoint");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("HTTP 500: Internal Server Error");
        expect(error.code).toBe("UNKNOWN_ERROR");
        expect(error.status).toBe(500);
      }
    });

    it("should not include retryAfterSec if not provided", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          error: {
            code: "BAD_REQUEST",
            message: "Bad request",
            retryable: false,
          },
        }),
      });

      try {
        await httpClient.get("https://api.test.com/endpoint");
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.retryAfterSec).toBeUndefined();
      }
    });
  });
});