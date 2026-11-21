// A TCP proxy that delays every chunk by a fixed time in each direction, to run against a local database as if it were
// across a network link. The default 10 ms each way is the 20 ms round trip from the cluster to the hosted database.
//
//   node scripts/latency-proxy.ts <target host:port> [--delay MS] [--port N]
//
// prints `127.0.0.1:<port>` once it listens; Ctrl-C stops it. Tests import `startLatencyProxy`.
import { createServer, connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

export interface LatencyProxy {
  port: number;
  close(): Promise<void>;
}

/** Forwards `from` to `to`, each chunk `delayMs` later. Chunks keep their order: timers with one delay fire in order. */
function delayed(from: Socket, to: Socket, delayMs: number): void {
  from.on("data", (chunk) => void setTimeout(() => to.destroyed || to.write(chunk), delayMs));
  from.on("end", () => void setTimeout(() => to.end(), delayMs));
  from.on("error", () => to.destroy());
  from.on("close", () => void setTimeout(() => to.destroy(), delayMs));
}

/** Listens on 127.0.0.1 (`port` 0 picks a free one) and forwards each connection to `target` with the delay. */
export function startLatencyProxy(target: { host: string; port: number }, opts: { delayMs?: number; port?: number } = {}): Promise<LatencyProxy> {
  const delayMs = opts.delayMs ?? 10;
  const sockets = new Set<Socket>();
  const server = createServer({ noDelay: true }, (client) => {
    const upstream = connect({ host: target.host, port: target.port, noDelay: true });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    }
    delayed(client, upstream, delayMs);
    delayed(upstream, client, delayMs);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise<void>((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string): number | undefined => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : Number(args[i + 1]);
  };
  const m = /^(.+):(\d+)$/.exec(args[0] ?? "");
  if (!m) {
    console.error("usage: node scripts/latency-proxy.ts <target host:port> [--delay MS] [--port N]");
    process.exit(2);
  }
  const proxy = await startLatencyProxy({ host: m[1]!, port: Number(m[2]) }, { delayMs: flag("--delay"), port: flag("--port") });
  console.log(`127.0.0.1:${proxy.port}`);
  const stop = () => void proxy.close().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
