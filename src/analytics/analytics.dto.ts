export interface TrackEventInput {
  name: string;
  anonId?: string;
  sessionId?: string;
  path?: string;
  props?: Record<string, unknown>;
  ts?: number; // client timestamp (informational; server stamps createdAt)
}

export interface TrackBatchInput {
  events: TrackEventInput[];
}
