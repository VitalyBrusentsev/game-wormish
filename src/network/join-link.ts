export interface JoinLinkData {
  roomCode: string;
  joinCode: string;
}

const ROOM_CODE_PATTERN = /^[A-Z0-9]{8}$/;
const JOIN_CODE_PATTERN = /^\d{6}$/;

export const isValidRoomCode = (roomCode: string): boolean => ROOM_CODE_PATTERN.test(roomCode);

export const isValidJoinCode = (joinCode: string): boolean => JOIN_CODE_PATTERN.test(joinCode);

export const createJoinLinkUrl = (baseUrl: string, data: JoinLinkData): string => {
  const roomCode = data.roomCode.trim().toUpperCase();
  const joinCode = data.joinCode.trim();
  if (!isValidRoomCode(roomCode)) {
    throw new Error("Invalid room code");
  }
  if (!isValidJoinCode(joinCode)) {
    throw new Error("Invalid join code");
  }

  const url = new URL(baseUrl);
  const fragment = new URLSearchParams();
  fragment.set("room", roomCode);
  fragment.set("join", joinCode);
  url.hash = fragment.toString();
  return url.toString();
};

export const parseJoinLinkHash = (hash: string): JoinLinkData | null => {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;

  const fragment = new URLSearchParams(raw);
  const roomCode = (fragment.get("room") ?? "").trim().toUpperCase();
  const joinCode = (fragment.get("join") ?? "").trim();
  if (!isValidRoomCode(roomCode) || !isValidJoinCode(joinCode)) {
    return null;
  }

  return { roomCode, joinCode };
};
