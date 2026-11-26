export interface RealtimeEphemeralTokenRequest {
  session: Record<string, unknown>;
}

export interface RealtimeEphemeralTokenResponse {
  value: string;
  expiresAt?: number;
}
