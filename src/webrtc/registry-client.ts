import type {
  IRegistryClient,
  IHttpClient,
  RoomCreationResponse,
  PublicRoomInfo,
  RoomJoinResponse,
  RoomSnapshot,
  CandidateList,
} from "./types";

/**
 * Registry Client for interacting with the Cloudflare Registry API
 * 
 * Handles all HTTP communication with the Registry API for:
 * - Room creation and joining
 * - SDP offer/answer exchange
 * - ICE candidate exchange
 * - Room state polling
 */
export class RegistryClient implements IRegistryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly httpClient: IHttpClient
  ) {}

  /**
   * Create a new room (host)
   * @param hostUserName - The host's username (1-32 chars, alphanumeric + _ -)
   */
  async createRoom(hostUserName: string): Promise<RoomCreationResponse> {
    const url = `${this.baseUrl}/rooms`;
    return this.httpClient.post(url, { hostUserName });
  }

  /**
   * Get public room information (guest, before joining)
   * @param roomCode - The room code to lookup
   */
  async getPublicRoomInfo(roomCode: string): Promise<PublicRoomInfo> {
    const url = `${this.baseUrl}/rooms/${roomCode}/public`;
    return this.httpClient.get(url);
  }

  /**
   * Join an existing room (guest)
   * @param roomCode - The room code
   * @param joinCode - The join code provided by host
   * @param guestUserName - The guest's username
   */
  async joinRoom(
    roomCode: string,
    joinCode: string,
    guestUserName: string
  ): Promise<RoomJoinResponse> {
    const url = `${this.baseUrl}/rooms/${roomCode}/join`;
    return this.httpClient.post(url, { joinCode, guestUserName });
  }

  /**
   * Post SDP offer to the room
   * @param roomCode - The room code
   * @param token - The access token (ownerToken or guestToken)
   * @param offer - The SDP offer
   */
  async postOffer(
    roomCode: string,
    token: string,
    offer: RTCSessionDescriptionInit
  ): Promise<void> {
    const url = `${this.baseUrl}/rooms/${roomCode}/offer`;
    await this.httpClient.post(
      url,
      offer,
      { "X-Access-Token": token }
    );
  }

  /**
   * Post SDP answer to the room
   * @param roomCode - The room code
   * @param token - The access token (ownerToken or guestToken)
   * @param answer - The SDP answer
   */
  async postAnswer(
    roomCode: string,
    token: string,
    answer: RTCSessionDescriptionInit
  ): Promise<void> {
    const url = `${this.baseUrl}/rooms/${roomCode}/answer`;
    await this.httpClient.post(
      url,
      answer,
      { "X-Access-Token": token }
    );
  }

  /**
   * Post an ICE candidate to the room
   * @param roomCode - The room code
   * @param token - The access token
   * @param candidate - The ICE candidate
   */
  async postCandidate(
    roomCode: string,
    token: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    const url = `${this.baseUrl}/rooms/${roomCode}/candidate`;
    await this.httpClient.post(
      url,
      candidate,
      { "X-Access-Token": token }
    );
  }

  /**
   * Get the current room state
   * @param roomCode - The room code
   * @param token - The access token
   */
  async getRoom(roomCode: string, token: string): Promise<RoomSnapshot> {
    const url = `${this.baseUrl}/rooms/${roomCode}`;
    return this.httpClient.get(url, { "X-Access-Token": token });
  }

  /**
   * Get ICE candidates from the peer
   * @param roomCode - The room code
   * @param token - The access token
   */
  async getCandidates(roomCode: string, token: string): Promise<CandidateList> {
    const url = `${this.baseUrl}/rooms/${roomCode}/candidates`;
    return this.httpClient.get(url, { "X-Access-Token": token });
  }

  /**
   * Close the room
   * @param roomCode - The room code
   * @param token - The access token
   */
  async closeRoom(roomCode: string, token: string): Promise<void> {
    const url = `${this.baseUrl}/rooms/${roomCode}/close`;
    await this.httpClient.post(url, undefined, { "X-Access-Token": token });
  }
}