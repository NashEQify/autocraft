// The runner's half of warm placement (src/warm/placement.ts): at most every PLACE_EVERY_MS it places the covered repos'
// keys on the nodes that reported within the agents' default grace period (new keys only on fresh ones) and writes `warm-placement` when the result changed. It never creates the
// ConfigMap (the cluster's configuration does, once), so without it nothing changes and every node keeps every key that
// `warm-assign` lists. Nothing is written while no node reports or no repo is covered: an empty placement would make
// every node drop what it holds.
import type { Db } from "../db/index.ts";
import { parsePlacement, PLACEMENT_CONFIGMAP, PLACEMENT_DATA_KEY, placeKeys, type Placement } from "../warm/placement.ts";
import { DEFAULT_GRACE_MS } from "../warm/sync-agent.ts";
import type { ConfigMapApi } from "./kube-api.ts";
import { warmKeyOf } from "./tasks.ts";
import { warmBytes, warmCoverage } from "./warm-queue.ts";
import type { WarmStatus } from "./warm-status.ts";

export const PLACE_EVERY_MS = 5 * 60_000;
const ASSIGN_CONFIGMAP = "warm-assign";

export class WarmPlacer {
  private at = -Infinity;
  private lastNote: string | null = null;
  /** The placement in force as the last pass read or wrote it; null before a pass got that far or when there is none. */
  current: Placement | null = null;
  /** Why the last pass could not place (shown on the caches report); null when it could. */
  note: string | null = null;
  private readonly api: Pick<ConfigMapApi, "getConfigMap" | "patchConfigMap">;
  private readonly o: { namespace: string; now: () => number; log: (line: string) => void };
  constructor(api: Pick<ConfigMapApi, "getConfigMap" | "patchConfigMap">, o: { namespace: string; now: () => number; log: (line: string) => void }) {
    this.api = api;
    this.o = o;
  }

  private warn(m: string) {
    if (m !== this.lastNote) this.o.log(`warm placement: ${m}`);
    this.lastNote = m;
    this.note = m;
  }

  async pass(db: Db, status: WarmStatus): Promise<void> {
    if (this.o.now() - this.at < PLACE_EVERY_MS) return;
    this.at = this.o.now();
    const ns = this.o.namespace;
    try {
      const nodes = status.recentNodes(DEFAULT_GRACE_MS);
      const repos = (await warmCoverage(db)).repos;
      if (!nodes.some((n) => n.fresh) || !repos.length) return;
      const cm = await this.api.getConfigMap(ns, PLACEMENT_CONFIGMAP);
      if (!cm) {
        this.current = null;
        return this.warn(`ConfigMap ${PLACEMENT_CONFIGMAP} is missing in ${ns}, so every node keeps every key warm-assign lists`);
      }
      const gb = Number((await this.api.getConfigMap(ns, ASSIGN_CONFIGMAP))?.data?.maxGbPerNode);
      const keys: { key: string; bytes: number | null }[] = [];
      for (const r of repos) {
        const key = warmKeyOf(r.repo);
        keys.push({ key, bytes: await warmBytes(db, key) });
      }
      const was = cm.data?.[PLACEMENT_DATA_KEY];
      const next = JSON.stringify(placeKeys(keys, nodes, parsePlacement(was), gb > 0 ? gb * 1024 ** 3 : null));
      if (next !== was) {
        await this.api.patchConfigMap(ns, PLACEMENT_CONFIGMAP, { data: { [PLACEMENT_DATA_KEY]: next } });
        this.o.log(`warm placement: ${parsePlacement(next)!.keys.map((k) => `${k.key} on ${k.nodes.join(", ") || "no node"}`).join("; ")}`);
      }
      this.current = parsePlacement(next);
      this.lastNote = null;
      this.note = null;
    } catch (e) {
      this.warn((e as Error).message.slice(0, 300));
    }
  }
}
