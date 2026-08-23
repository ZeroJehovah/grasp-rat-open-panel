export interface MapMetadata {
  id: string;
  version: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  center: { x: number; y: number };
  directions: string[];
  metersPerGameUnit: number;
  source?: string;
  coordinateUnit?: string;
  worldRadius?: number;
  shape?: 'circle' | 'polygon';
}

export interface PlayerState {
  hp: number | null;
  maxHp: number | null;
  x: number | null;
  y: number | null;
  stamina5s: number | null;
  stamina1h: number | null;
  stamina1d: number | null;
  stamina5sLimit: number | null;
  stamina1hLimit: number | null;
  stamina1dLimit: number | null;
  currentJoinMode: string | null;
  life: string | null;
  snapshotId: string;
  observedAt: string;
}

export interface QuotaView {
  day: string;
  initial: number | null;
  value: number | null;
  income: number | null;
}

export interface Player {
  userId: number;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  currentEntityId: number | null;
  drop: number | null;
  quota: QuotaView | null;
  income: number | null;
  kills: number;
  deaths: number;
  state: PlayerState | null;
}

export interface Message {
  message_id?: string;
  server_day?: string;
  messageId?: string;
  local_date?: string;
  event_at?: string;
  eventAt?: string;
  kind: string;
  text: string;
  user_id?: number | null;
  target_user_id?: number | null;
  user_name?: string | null;
  target_name?: string | null;
}

export interface Kill {
  kill_id?: string;
  killId?: string;
  local_date?: string;
  server_day?: string;
  event_at?: string;
  eventAt?: string;
  killer_user_id?: number | null;
  victim_user_id?: number | null;
  killer_name?: string | null;
  victim_name?: string | null;
  confidence: 'confirmed' | 'inferred' | 'unknown';
  drop?: { amount?: number | null; confidence?: string; evidence_snapshot_id?: string | null } | null;
  victim_position?: { x: number | null; y: number | null } | null;
  killer_position?: { x: number | null; y: number | null } | null;
  victim_stamina_5s?: number | null;
  victim_stamina_5s_limit?: number | null;
}

export interface MetaResponse {
  map: MapMetadata;
  availableDates: string[];
  earliestDate: string | null;
  latestDate: string | null;
  timezone: string;
  schemaVersion: string;
  features: Record<string, boolean>;
}

export interface RealtimeResponse {
  unchanged?: boolean;
  versionToken: string | null;
  generatedAt: string;
  latest?: { snapshot_id: string; server_day: string; server_tick: number; observed_at: string } | null;
  map?: MapMetadata;
  players: Player[];
  messages: Message[];
  kills: Kill[];
  quota?: unknown[];
  stats?: unknown[];
  closedThrough?: string | null;
}

export interface HistoryResponse {
  from: string;
  to: string;
  timezone: string;
  generatedAt: string;
  closedThrough: string | null;
  players: Player[];
  messages: Message[];
  kills: Kill[];
  dailyQuota: unknown[];
  stats: unknown[];
}
