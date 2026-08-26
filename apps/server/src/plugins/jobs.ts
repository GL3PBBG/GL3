import type { PluginCtx, PluginManifest } from "@gl3/plugin-sdk";
import { isJobAlreadyAppliedError } from "@gl3/plugin-sdk";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createRng } from "../game/rng.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";
import { collectAssetSlots } from "./asset-slots.js";
import { collectAttributePools } from "./attribute-pools.js";
import { collectExpRouters } from "./exp-routers.js";
import { collectPropertyTypes } from "./property-types.js";

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
  return `${prefix}${pluginId}-${jobName}`;
}

export function createPluginQueues(
  redis: Redis, manifests: readonly PluginManifest[], prefix = "",
): Map<string, Queue> {
  const queues = new Map<string, Queue>();
  for (const manifest of manifests) {
    for (const jobName of Object.keys(manifest.jobs)) {
      queues.set(`${manifest.id}:${jobName}`, new Queue(
        pluginQueueName(prefix, manifest.id, jobName),
        {
          connection: redis,
          // Match core's crime queue (`queue/index.ts:21-26`): BullMQ's default
          // is attempts:1 (no retry), which would defeat the plugin_job_runs
          // idempotency guard (spec §2.5) and turn transient failures into
          // permanent event losses. The guard makes a retry safe for any job.
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 500 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        },
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
  // The widening jobs.ts's own narrowing comment prescribed: exp routing is
  // cross-plugin by nature — crimes' job must see the progression plugin's
  // claimant — so a caller with the full boot list passes it here. Defaults
  // to the single manifest for every caller that has nothing routed.
  allManifests: readonly PluginManifest[] = [manifest],
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
    filters: manifest.filters.map((subscription) => ({ ownerId: manifest.id, subscription })),
    // `runPluginJob` receives one manifest, not the set — the same narrowing
    // `filters` above already has. No job reads the registry today; if one
    // ever needs a type another plugin declares, this signature is what has
    // to widen.
    propertyTypes: collectPropertyTypes([manifest]),
    // NOT like propertyTypes/installedPluginIds below — those are
    // informational registries, but `attributePools` is a behavioural input
    // to `settlePool`. Narrowed to this one manifest, the same way, but the
    // consequence is sharper: a gameplay plugin (crimes, combat) does not
    // declare a pool, so inside ITS job `settleAll` resolves every pool to
    // `null` and `settlePool` takes the `decl === null` no-op branch — it
    // reads raw, unsettled `player_stats` columns. The regen clock does not
    // run inside any job.
    //
    // Crimes is correct today only by coupling, not by construction: its
    // route pre-check calls `tx.attributes.read` in its own committed
    // transaction immediately before the job is enqueued, so by the time the
    // job reads the row the settle is already persisted. That coupling is
    // load-bearing — do not remove the route-side read without replacing
    // what it does here.
    //
    // Any future plugin that calls `tx.attributes.read` or `.grant` from its
    // OWN job, without an equivalent pre-settle, gets a frozen clock — worse,
    // a `grant` against an unseeded `max` of `0` clamps to `0` and is a
    // silent no-op. If that ever bites, the fix is widening `runPluginJob`
    // to take the full manifest list (as `propertyTypes`/`installedPluginIds`
    // could be widened too), not special-casing this call.
    attributePools: collectAttributePools([manifest]),
    // Same narrowing as propertyTypes above: a job sees only its own plugin's
    // id today. No job calls buildRegistry yet.
    installedPluginIds: new Set([manifest.id]),
    // Core's own slots plus this plugin's, matching the narrowing above: a job
    // resolving art for a core table (`items`) is the realistic case, another
    // plugin's is not.
    assetSlots: collectAssetSlots([manifest]),
    // NOT narrowed: exp routing is behavioural and cross-plugin — the crimes
    // job diverts exp to the progression plugin's claimant. Every other
    // registry above stays narrowed on purpose (their comments rule).
    expRouter: collectExpRouters(allManifests),
  });

  try {
    await handler(ctx, job.data);
  } catch (error) {
    // Already applied is the expected outcome of a retry after a committed
    // run, not a failure — swallowing it here is what stops BullMQ from
    // burning its remaining attempts on work that is already done.
    // Structural, not `instanceof` — see routes.ts and the SDK's errors.ts.
    if (isJobAlreadyAppliedError(error)) return;
    throw error;
  }
}

export function createPluginWorkers(
  deps: PluginCtxDeps, manifests: readonly PluginManifest[], prefix = "",
): Worker[] {
  const workers: Worker[] = [];
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.jobs)) {
      const worker = new Worker(
        pluginQueueName(prefix, manifest.id, name),
        async (job) => { await runPluginJob(deps, manifest, name, job, manifests); },
        // concurrency:5 matches core's deleted crime worker (`startCrimeWorker`,
        // same reasoning as the `defaultJobOptions` block in
        // `createPluginQueues` above) — BullMQ's default is 1 (serial), which
        // would silently regress every plugin job to one-at-a-time processing.
        { connection: deps.redis, concurrency: 5 },
      );
      // A job that exhausts its attempts otherwise dies in silence: BullMQ
      // reports failures only through these events, and the player just sees
      // a claimed cooldown and no resolution. The crime_log job-id collision
      // (migration 0006) burned three attempts here without one log line —
      // same console idiom as ctx.log (ctx.ts).
      worker.on("failed", (job, error) => {
        console.error(
          { plugin: manifest.id, job: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: String(error) },
          "plugin job failed",
        );
      });
      worker.on("error", (error) => {
        console.error({ plugin: manifest.id, job: name, err: String(error) }, "plugin worker error");
      });
      workers.push(worker);
    }
  }
  return workers;
}
