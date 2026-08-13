import type { ProviderProvenance, RiverReading, TransitVehicle } from "../lib/types";

export { addEstimatedSpeeds } from "./live-normalize.js";

export class NtaFeedCoordinator {
  constructor(state: unknown, env: unknown);
  fetch(request: Request | string): Promise<Response>;
}

export class RiverFeedCoordinator {
  constructor(state: unknown, env: unknown);
  fetch(request: Request | string): Promise<Response>;
}

export function historyLivingSnapshot(
  env: unknown,
  captureBucketStartMs?: number
): Promise<{
  trains: unknown[];
  rivers: RiverReading[];
  sourceStatus: { trains: string; rivers: string };
  sourceProvenance: { trains: ProviderProvenance; rivers: ProviderProvenance };
}>;

export function historyTransitSnapshot(
  env: unknown,
  captureBucketStartMs?: number
): Promise<{
  transit: TransitVehicle[];
  transitStatus: string;
  aggregate: unknown;
  latestObservedAt: string | null;
}>;

export function runPaidHistoryTick(
  env: unknown,
  scheduledTime: number,
  options?: { capture?: typeof import("./history.js").captureHistory; maintain?: typeof import("./history.js").maintainHistory }
): Promise<unknown>;

declare const cloudflareWorker: {
  fetch(request: Request, env: unknown): Promise<Response>;
  scheduled(
    controller: { cron?: string; scheduledTime: number },
    env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<void> | void;
};
export default cloudflareWorker;
