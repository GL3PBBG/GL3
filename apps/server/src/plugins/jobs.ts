import type { PluginCtx, PluginManifest } from "@gl3/plugin-sdk";
import { JobAlreadyAppliedError } from "@gl3/plugin-sdk";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createRng } from "../game/rng.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";

/**
 * The function shape a plugin's job handler must satisfy. `manifest.jobs` is
 * typed `Record<string, unknown>` at the SDK layer (functions cannot be
 * zod-validated), so the loader and this module narrow each entry to this
 * type before calling it.
 */
export type JobHandler = (ctx: PluginCtx, data: Record<string, unknown>) => Promise<void>;

/** Shape of the parts of a BullMQ job this module reads. */
export interface PluginJobLike { id?: string | undefined; data: Record<string, unknown> }

export function pluginQueueName(prefix: string, pluginId: string, jobName: string): string {
  return `${prefix}${pluginId}:${jobName}`;
}

export function createPluginQueues(
  redis: Redis, manifests: readonly PluginManifest[], prefix = "",
): Map<string, Queue> {
  const queues = new Map<string, Queue>();
  for (const manifest of manifests) {
    for (const jobName of Object.keys(manifest.jobs)) {
      queues.set(`${manifest.id}:${jobName}`, new Queue(
        pluginQueueName(prefix, manifest.id, jobName), { connection: redis },
      ));
    }
  }
  return queues;
}

/**
 * The processor body, exported so a test can invoke it twice with the same
 * job id — which is exactly what a BullMQ retry does, without needing to
 * force a real failure to observe it.
 */
export async function runPluginJob(
  deps: PluginCtxDeps, manifest: PluginManifest, name: string, job: PluginJobLike,
): Promise<void> {
  const entry = manifest.jobs[name];
  if (entry === undefined) throw new Error(`plugin "${manifest.id}" has no job "${name}"`);
  if (typeof entry !== "function") throw new Error(`plugin "${manifest.id}" job "${name}" is not a function`);
  const handler = entry as JobHandler;

  const jobId = job.id;
  if (jobId === undefined) throw new Error(`plugin job "${manifest.id}:${name}" ran without a job id`);

  const seed = String(job.data["seed"] ?? "");
  const ctx = createPluginCtx(deps, {
    pluginId: manifest.id,
    player: null,
    job: { id: jobId, seed, rng: createRng(seed) },
    filters: manifest.filters,
  });

  try {
    await handler(ctx, job.data);
  } catch (error) {
    // Already applied is the expected outcome of a retry after a committed
    // run, not a failure — swallowing it here is what stops BullMQ from
    // burning its remaining attempts on work that is already done.
    if (error instanceof JobAlreadyAppliedError) return;
    throw error;
  }
}

export function createPluginWorkers(
  deps: PluginCtxDeps, manifests: readonly PluginManifest[], prefix = "",
): Worker[] {
  const workers: Worker[] = [];
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.jobs)) {
      workers.push(new Worker(
        pluginQueueName(prefix, manifest.id, name),
        async (job) => { await runPluginJob(deps, manifest, name, job); },
        { connection: deps.redis },
      ));
    }
  }
  return workers;
}
