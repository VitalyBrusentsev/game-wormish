import type { IHttpClient } from "./types";

/**
 * HTTP Client with built-in CORS and CSRF protection for Registry API
 * 
 * Automatically handles:
 * - CORS mode with credentials omitted
 * - CSRF protection via X-Registry-Version header on POST requests
 * - JSON content type headers
 */
export class HttpClient implements IHttpClient {
  /**
   * Performs a GET request
   * @param url - The URL to fetch
   * @param headers - Optional additional headers
   */
  async get(url: string, headers?: Record<string, string>): Promise<any> {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    return response.json();
  }

  /**
   * Performs a POST request with CSRF protection
   * @param url - The URL to post to
   * @param body - Optional request body
   * @param headers - Optional additional headers
   */
  async post(url: string, body?: any, headers?: Record<string, string>): Promise<any> {
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "X-Registry-Version": "1", // CSRF protection
        ...headers,
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    // POST might return no content (204) or JSON
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json();
    }
    return undefined;
  }

  /**
   * Handles error responses from the API
   * @param response - The failed response
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    let errorCode = "UNKNOWN_ERROR";
    let retryable = false;
    let retryAfterSec: number | undefined;

    try {
      const errorData = await response.json();
      if (errorData.error) {
        errorMessage = errorData.error.message || errorMessage;
        errorCode = errorData.error.code || errorCode;
        retryable = errorData.error.retryable || false;
        retryAfterSec = errorData.error.retryAfterSec;
      }
    } catch {
      // Failed to parse error response, use default message
    }

    const error = new Error(errorMessage) as Error & {
      code: string;
      status: number;
      retryable: boolean;
      retryAfterSec?: number;
    };
    error.code = errorCode;
    error.status = response.status;
    error.retryable = retryable;
    if (retryAfterSec !== undefined) {
      error.retryAfterSec = retryAfterSec;
    }

    throw error;
  }
}