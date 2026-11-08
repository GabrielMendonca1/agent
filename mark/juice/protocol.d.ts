export type JuiceMode = 'simple' | 'complex';
export interface JuicePreferences { mode: JuiceMode; supportModel: string | null }
export interface JuicePending {
  callId: string;
  model: string;
  kind: string;
  reservedOutputTokens: number;
  status: 'reserved' | 'unknown';
}
export interface JuiceTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  usd: number;
}
export interface JuiceGroup {
  calls: number;
  settled: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}
/** Cache telemetry: only numbers and closed enums, never payload text. */
export interface JuiceCache {
  gaps: {
    count: number;
    censored: number;
    /** `le` is the bucket upper edge in seconds; null is the unbounded bucket. */
    buckets: { le: number | null; returned: number; censored: number }[];
    hazard: { le: number | null; p: number }[];
  };
  breaks: Record<string, number>;
  warmSkips: Record<string, number>;
  /** D: `"<compaction|prune>:<deferred|allowed>:<cause>"` → contagem. */
  decisions: Record<string, number>;
}
export interface JuiceReceipt extends JuicePending {
  status: 'settled' | 'cancelled' | 'reserved' | 'unknown';
  outputTokens?: number;
  usage?: Record<string, number | Record<string, number>>;
}
/**
 * Pure accounting: no limits, no pause, no grant. Bounded by construction:
 * receipts never travel in a reply, only counts, aggregates and the pending tail.
 */
export interface JuiceState {
  version: 2;
  runId: string;
  mode: JuiceMode;
  calls: { used: number };
  output: { used: number; reserved: number };
  /** Accumulated cost in USD, from each settlement's usage.cost.total. */
  usd: number;
  pendingCount: number;
  /** Last 50 pending entries only. */
  pending: JuicePending[];
  receiptCount: number;
  totals: JuiceTotals;
  byKind: Record<string, JuiceGroup>;
  cache: JuiceCache;
}
export interface JuiceReport {
  totals: JuiceTotals;
  byKind: Record<string, JuiceGroup>;
  byModel: Record<string, JuiceGroup>;
  warm: { pings: number; cacheRead: number; cacheWrite: number; usd: number };
  hitRate: number;
  cache: JuiceCache;
}
export interface JuiceCacheEvent {
  event: 'gap' | 'break' | 'warm_skip' | 'compaction' | 'prune';
  seconds?: number;
  censored?: boolean;
  /** break: causa da quebra; compaction|prune: causa da decisão D. */
  cause?: 'ttl-expired' | 'prompt-changed' | 'tools-changed' | 'model-changed' | 'compaction' | 'thinking-changed' | 'unknown'
    | 'warm' | 'cold' | 'hard-limit' | 'defer-budget' | 'unknown-usage' | 'manual' | 'overflow';
  action?: 'deferred' | 'allowed';
  reason?: 'thinking-budget' | 'window-closed' | 'no-payload' | 'error' | 'cost-cap';
}
/** Synchronous client.mjs API. Errors never imply zero usage. */
export interface JuiceClient {
  juiceEnabled(): boolean;
  getJuiceSnapshot(): JuiceState | null;
  /** Same read without blocking the event loop; for displays refreshed on every ledger write. */
  getJuiceSnapshotAsync(): Promise<JuiceState | null>;
  getJuicePreferences(): JuicePreferences;
  setJuicePreferences(patch: Partial<JuicePreferences>): JuicePreferences;
  /** Mode is a preference only; it carries no budget. */
  setJuiceMode(mode: JuiceMode): JuiceState | null;
  /** `juice <mode> · US$ 0.00`, or `juice <mode> · sem execução` without a run. */
  formatJuiceStatus(snapshot?: JuiceState | null, prefs?: JuicePreferences): string;
  /** Aggregates for the human; null without opt-in or run. */
  getJuiceReport(): JuiceReport | null;
  /** Observability only: never throws, false when not recorded. */
  recordJuiceCacheEvent(event: JuiceCacheEvent): boolean;
  /** Paged audit trail (oldest first); null without opt-in or run. */
  getJuiceReceipts(offset?: number, limit?: number): { total: number; offset: number; receipts: JuiceReceipt[] } | null;
}
