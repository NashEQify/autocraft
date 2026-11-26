// Request and reply with a worker thread, for synchronous work (native model runs, node:sqlite queries) that must not
// hold the calling thread's event loop. One worker per ThreadCall, started on the first call and kept; calls queue in it
// one at a time. The worker keeps the process alive only while a call waits for its reply.
import { parentPort, Worker } from "node:worker_threads";

type Reply<R> = { n: number; ok: true; value: R } | { n: number; ok: false; error: string };

export class ThreadCall<Q, R> {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { ok: (v: R) => void; fail: (e: Error) => void }>();
  private seq = 0;
  private readonly url: URL;
  private readonly what: string;
  private readonly workerData: unknown;

  /** `what` names the worker in errors. */
  constructor(url: URL, what: string, workerData?: unknown) {
    this.url = url;
    this.what = what;
    this.workerData = workerData;
  }

  call(q: Q): Promise<R> {
    return new Promise((ok, fail) => {
      const w = this.spawn();
      const n = ++this.seq;
      if (!this.pending.size) w.ref();
      this.pending.set(n, { ok, fail });
      w.postMessage({ n, q });
    });
  }

  /** Stops the worker; calls still waiting fail. */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    await w?.terminate();
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.url, { workerData: this.workerData });
    const fail = (e: Error): void => {
      if (this.worker === w) this.worker = null;
      for (const p of this.pending.values()) p.fail(e);
      this.pending.clear();
    };
    w.on("message", (m: Reply<R>) => {
      const p = this.pending.get(m.n);
      this.pending.delete(m.n);
      if (!this.pending.size) w.unref();
      if (!p) return;
      if (m.ok) p.ok(m.value);
      else p.fail(new Error(m.error));
    });
    w.on("error", fail);
    w.on("exit", (code) => fail(new Error(`the ${this.what} worker stopped (exit code ${code})`)));
    w.unref();
    return (this.worker = w);
  }
}

/** The worker side: answers each call with `handle`'s result or its error message, one call at a time. */
export function serveCalls<Q, R>(handle: (q: Q) => R | Promise<R>): void {
  const port = parentPort;
  if (!port) throw new Error("serveCalls runs in a worker thread");
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (m: { n: number; q: Q }) => {
    queue = queue.then(async () => {
      try {
        port.postMessage({ n: m.n, ok: true, value: await handle(m.q) } satisfies Reply<R>);
      } catch (e) {
        port.postMessage({ n: m.n, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply<R>);
      }
    });
  });
}
