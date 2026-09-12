export type Mode = "image" | "video";
export type State =
  | "queued"
  | "submitting"
  | "running"
  | "downloading"
  | "ready"
  | "failed"
  | "unknown"
  | "tracking_failed"
  | "download_failed"
  | "paused"
  | "cancelled";
export interface Recipe {
  mode: Mode;
  model: string;
  prompt: string;
  parameters: Record<string, string | number | boolean>;
}
export interface Job {
  provider?: "atlas";
  credentialRef?: string;
  pollCount?: number;
  trackingStarted?: number;
  downloadAttempts?: number;
  id: string;
  created: number;
  recipe: Recipe;
  state: State;
  remoteId?: string;
  outputs?: string[];
  message?: string;
  attempts: number;
  nextPoll: number;
}
export interface Asset {
  width?: number;
  height?: number;
  duration?: number;
  id: string;
  jobId: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
}
export type PublicJob = Omit<Job, "outputs" | "remoteId" | "credentialRef"> & {
  hasRemoteJob: boolean;
};
export type PublicAsset = Omit<Asset, "filename"> & {
  url: string;
  missing: boolean;
};
export type Control = { key: string; label: string; description?: string } & (
  | { kind: "select"; options: (string | number)[]; default: string | number }
  | {
      kind: "number";
      min: number;
      max: number;
      step?: number;
      integer: boolean;
      default: number;
    }
  | { kind: "toggle"; default: boolean }
  | { kind: "text"; default: string; maxLength: number }
);
export interface Model {
  fixedParameters: Recipe["parameters"];
  id: string;
  name: string;
  mode: Mode;
  controls: Control[];
  source: string;
  organization?: string;
  description?: string;
  price?: string;
}
// One selectable row of the Atlas listing. `ready` means its schema is resolved locally.
export interface CatalogEntry {
  id: string;
  name: string;
  mode: Mode;
  organization: string;
  description: string;
  price?: string;
  ready: boolean;
  unsupported?: string;
}
export interface Snapshot {
  modelDefaults: Record<Mode, string>;
  jobs: PublicJob[];
  assets: PublicAsset[];
  models: Model[];
  catalog: {
    entries: CatalogEntry[];
    updated?: number;
    refreshing: boolean;
    online: boolean;
  };
  credentials: {
    configured: boolean;
    storage: "encrypted" | "file" | "session" | "environment" | "none";
    secureAvailable: boolean;
  };
}
export interface Bridge {
  saveModelDefault(mode: Mode, model: string): Promise<void>;
  refreshCatalog(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  enqueue(token: string, recipe: Recipe): Promise<string>;
  saveKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  retry(id: string): Promise<void>;
  cancelQueued(id: string): Promise<void>;
  stopTracking(id: string): Promise<void>;
  exportAsset(id: string): Promise<boolean>;
  reveal(id: string): Promise<void>;
  openAsset(id: string): Promise<void>;
}
export interface Provider {
  submit(recipe: Recipe, key: string): Promise<string>;
  poll(
    id: string,
    key: string,
  ): Promise<{ state: "running" | "ready" | "failed"; outputs?: string[] }>;
}
export type Downloaded = Omit<Asset, "jobId">;
