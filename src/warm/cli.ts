// `autocraft-server warm-sync`: the per-node warm-sync agent (src/warm/sync-agent.ts), configured by AUTOCRAFT_WARM_*.
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inClusterApi, SA_DIR } from "../build/kube-api.ts";
import { checkServiceUrl } from "../worker/config.ts";
import { WarmStore } from "./store-client.ts";
import { readAssignDir, SyncAgent } from "./sync-agent.ts";

const USAGE = `usage: autocraft-server warm-sync [--once]
  AUTOCRAFT_WARM_STORE_URL         WebDAV root of the warm store, read-only (required)
  AUTOCRAFT_WARM_VERIFY_KEYS       comma-separated public key PEM files (required)
  AUTOCRAFT_WARM_NODE              this node's name (required; the status ConfigMap is warm-status-<node>)
  AUTOCRAFT_WARM_DIR               node directory (default /var/lib/craft-warm)
  AUTOCRAFT_WARM_ASSIGN_DIR        mounted warm-assign ConfigMap with files repos and maxGbPerNode (default /etc/warm-assign)
  AUTOCRAFT_WARM_STATUS_NAMESPACE  namespace of the status ConfigMap (default: the pod's own)
  AUTOCRAFT_WARM_WRITE_MB_PER_SEC  disk write rate of downloads, 0 for none (default 150)
  AUTOCRAFT_WARM_POLL_SEC (60), AUTOCRAFT_WARM_GRACE_MIN (60), AUTOCRAFT_WARM_MAX_FS_PCT (80)`;

function config(env: NodeJS.ProcessEnv) {
  const v = (n: string) => env[`AUTOCRAFT_WARM_${n}`]?.trim() || undefined;
  const need = (n: string) => v(n) ?? fail(`AUTOCRAFT_WARM_${n} is required`);
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const num = (n: string, dflt: number, min: number) => {
    const x = Number(v(n) ?? dflt);
    return Number.isFinite(x) && x >= min ? x : fail(`AUTOCRAFT_WARM_${n} must be a number of at least ${min}`);
  };
  const path = (n: string, dflt: string) => {
    const p = v(n) ?? dflt;
    return isAbsolute(p) ? p : fail(`AUTOCRAFT_WARM_${n} must be an absolute path`);
  };
  const url = need("STORE_URL");
  checkServiceUrl(url, "AUTOCRAFT_WARM_STORE_URL");
  const keyFiles = need("VERIFY_KEYS").split(",").map((f) => f.trim()).filter(Boolean);
  const pct = num("MAX_FS_PCT", 80, 1);
  if (pct > 100) fail("AUTOCRAFT_WARM_MAX_FS_PCT must be at most 100");
  let namespace = v("STATUS_NAMESPACE");
  if (!namespace) {
    try {
      namespace = readFileSync(`${SA_DIR}/namespace`, "utf8").trim();
    } catch { /* outside a cluster */ }
  }
  return {
    url, keyFiles, node: need("NODE"), dir: path("DIR", "/var/lib/craft-warm"), assignDir: path("ASSIGN_DIR", "/etc/warm-assign"),
    namespace: namespace || "craft-cache", writeBytesPerSec: num("WRITE_MB_PER_SEC", 150, 0) * 1e6,
    pollMs: num("POLL_SEC", 60, 5) * 1000, graceMs: num("GRACE_MIN", 60, 1) * 60_000, maxFsPct: pct,
  };
}

async function warmSync(args: string[]): Promise<void> {
  if (args.some((a) => a !== "--once")) {
    console.error(USAGE);
    process.exit(2);
  }
  let c: ReturnType<typeof config>;
  try {
    c = config(process.env);
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const kube = inClusterApi();
  if (!kube) log("warm sync: not in a Kubernetes cluster, so no status ConfigMap is written");
  const agent = new SyncAgent({
    dir: c.dir, node: c.node, namespace: c.namespace, kube, log,
    store: new WarmStore({ readUrl: c.url }),
    verifyKeys: () => c.keyFiles.map((f) => createPublicKey(readFileSync(f))),
    assign: () => readAssignDir(c.assignDir),
    writeBytesPerSec: c.writeBytesPerSec, graceMs: c.graceMs, maxFsPct: c.maxFsPct,
  });
  log(`warm sync: node ${c.node}, dir ${c.dir}, every ${c.pollMs / 1000} s`);
  if (args.includes("--once")) return await agent.cycle();
  const ac = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => ac.abort());
  await agent.run(ac.signal, c.pollMs);
}

export const commands = {
  "warm-sync": { summary: "keep this node's warm dirs at the newest signed versions (runs in the warm-sync DaemonSet)", run: warmSync },
};
