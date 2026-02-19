import { describe, expect, it } from "vitest";
import { createJoinLinkUrl, parseJoinLinkHash } from "../join-link";

describe("join-link", () => {
  it("creates a share link with room and join in the hash fragment", () => {
    const url = createJoinLinkUrl("https://wormish.app/play?mode=network", {
      roomCode: "ABCD1234",
      joinCode: "123456",
    });

    expect(url).toBe("https://wormish.app/play?mode=network#room=ABCD1234&join=123456");
  });

  it("parses a valid hash fragment", () => {
    const parsed = parseJoinLinkHash("#room=ABCD1234&join=123456");

    expect(parsed).toEqual({ roomCode: "ABCD1234", joinCode: "123456" });
  });

  it("normalizes lowercase room code to uppercase", () => {
    const parsed = parseJoinLinkHash("#room=abcd1234&join=123456");

    expect(parsed).toEqual({ roomCode: "ABCD1234", joinCode: "123456" });
  });

  it("returns null when required fields are missing", () => {
    expect(parseJoinLinkHash("#room=ABCD1234")).toBeNull();
    expect(parseJoinLinkHash("#join=123456")).toBeNull();
  });

  it("returns null when values are invalid", () => {
    expect(parseJoinLinkHash("#room=BAD&join=123456")).toBeNull();
    expect(parseJoinLinkHash("#room=ABCD1234&join=not-a-code")).toBeNull();
  });
});
