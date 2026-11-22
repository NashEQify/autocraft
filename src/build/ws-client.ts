// A minimal WebSocket client (RFC 6455), as general as the Kubernetes exec stream needs: binary
// messages, masked client frames, fragmented messages, ping/pong and the close handshake.
// Only `node:` modules.
import { createHash, randomBytes, randomFillSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The largest frame, and the largest reassembled message, the client accepts. */
export const MAX_FRAME = 16 * 1024 * 1024;
/** How long a close we started waits for the server's close before the socket is dropped. */
const CLOSE_GRACE_MS = 2_000;

export type WsConnectOptions = {
  tls: boolean;
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  /** The one subprotocol requested; the server must choose it. */
  protocol: string;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
  connectTimeoutMs: number;
};

/** The upgrade did not happen. `status` is the HTTP status, 0 when no response came. */
export class WsHandshakeError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body = "") {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type WsHandlers = {
  onMessage: (data: Buffer) => void;
  /** Called once, when the connection is gone for any reason (1006: dropped without a close frame). */
  onClose: (code: number, reason: string) => void;
};

export function wsConnect(o: WsConnectOptions): Promise<WsConn> {
  const nonce = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (status: number, message: string, body = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      reject(new WsHandshakeError(status, message, body));
    };
    const req = (o.tls ? httpsRequest : httpRequest)({
      host: o.host, port: o.port, path: o.path, method: "GET", agent: false,
      ...(o.tls ? { ca: o.ca, cert: o.cert, key: o.key } : {}),
      headers: {
        ...o.headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": nonce,
        "sec-websocket-protocol": o.protocol,
      },
    });
    const timer = setTimeout(() => fail(0, "connect timed out"), o.connectTimeoutMs);
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      if (done) return void socket.destroy();
      const status = res.statusCode ?? 0;
      if (res.headers["sec-websocket-accept"] !== createHash("sha1").update(nonce + GUID).digest("base64")) {
        socket.destroy();
        return fail(status, "the server's Sec-WebSocket-Accept does not match");
      }
      if (res.headers["sec-websocket-protocol"] !== o.protocol) {
        socket.destroy();
        return fail(status, `the server did not choose the ${o.protocol} protocol`);
      }
      done = true;
      clearTimeout(timer);
      resolve(new WsConn(socket, head));
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        if (n < 4096) chunks.push(c);
        n += c.length;
      });
      res.on("end", () => fail(res.statusCode ?? 0, `HTTP ${res.statusCode}`, Buffer.concat(chunks).subarray(0, 4096).toString("utf8")));
      res.on("error", (e) => fail(res.statusCode ?? 0, e.message));
    });
    req.on("error", (e) => fail(0, e.message));
    req.end();
  });
}

export class WsConn {
  #socket: Duplex;
  #head: Buffer;
  #h: WsHandlers | null = null;
  #chunks: Buffer[] = [];
  #have = 0;
  #frags: Buffer[] = [];
  #fragLen = 0;
  #fragging = false;
  #sentClose = false;
  #closed = false;
  #grace: NodeJS.Timeout | null = null;

  constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    this.#head = head;
  }

  get closed() {
    return this.#closed;
  }

  /** Attaches the handlers and starts reading, so no message arrives before they are set. */
  start(h: WsHandlers) {
    this.#h = h;
    this.#socket.on("data", (c: Buffer) => this.#feed(c));
    this.#socket.on("close", () => this.#finish(1006, "connection closed"));
    this.#socket.on("error", () => {}); // "close" follows
    if (this.#head.length) this.#feed(this.#head);
  }

  /** Sends one binary message. False when the socket's buffer is full: wait for `drained()`. */
  send(data: Buffer): boolean {
    if (this.#closed || this.#sentClose) return false;
    return this.#write(2, data);
  }

  /** Resolves when the socket can take more data, or the connection is gone. */
  drained(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.#socket.off("drain", done);
        this.#socket.off("close", done);
        resolve();
      };
      this.#socket.on("drain", done);
      this.#socket.on("close", done);
    });
  }

  /** Starts the close handshake; the socket is dropped if the server does not answer in time. */
  close(code = 1000) {
    if (this.#closed || this.#sentClose) return;
    this.#sentClose = true;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.#write(8, p);
    this.#grace = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS);
    this.#grace.unref();
  }

  #write(op: number, payload: Buffer): boolean {
    const n = payload.length;
    const hl = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const f = Buffer.allocUnsafe(hl + 4 + n);
    f[0] = 0x80 | op;
    if (n < 126) f[1] = 0x80 | n;
    else if (n < 65536) {
      f[1] = 0x80 | 126;
      f.writeUInt16BE(n, 2);
    } else {
      f[1] = 0x80 | 127;
      f.writeBigUInt64BE(BigInt(n), 2);
    }
    const mask = randomFillSync(f.subarray(hl, hl + 4));
    for (let i = 0; i < n; i++) f[hl + 4 + i] = payload[i]! ^ mask[i & 3]!;
    return this.#socket.write(f);
  }

  #feed(c: Buffer) {
    this.#chunks.push(c);
    this.#have += c.length;
    while (!this.#closed && this.#have >= 2) {
      const h = this.#peek(Math.min(10, this.#have));
      const b0 = h[0]!, b1 = h[1]!;
      if (b1 & 0x80) return this.#fail(1002, "masked frame from the server");
      if (b0 & 0x70) return this.#fail(1002, "reserved bits set");
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (h.length < 4) return;
        len = h.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (h.length < 10) return;
        const big = h.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.#fail(1009, "frame too large");
        len = Number(big);
        off = 10;
      }
      if (len > MAX_FRAME) return this.#fail(1009, "frame too large");
      if (this.#have < off + len) return;
      this.#frame((b0 & 0x80) !== 0, b0 & 0x0f, this.#take(off + len).subarray(off));
    }
  }

  #peek(n: number): Buffer {
    if (this.#chunks[0]!.length < n) this.#chunks = [Buffer.concat(this.#chunks)];
    return this.#chunks[0]!.subarray(0, n);
  }

  #take(n: number): Buffer {
    const all = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks);
    const rest = all.subarray(n);
    this.#chunks = rest.length ? [rest] : [];
    this.#have = rest.length;
    return all.subarray(0, n);
  }

  #frame(fin: boolean, op: number, data: Buffer) {
    if (op >= 8) {
      if (!fin || data.length > 125) return this.#fail(1002, "bad control frame");
      if (op === 9) this.#write(10, data);
      else if (op === 8) {
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
        if (!this.#sentClose) {
          this.#sentClose = true;
          this.#write(8, data.subarray(0, 2));
        }
        this.#socket.end();
        this.#finish(code, data.subarray(2).toString("utf8"));
      } else if (op !== 10) this.#fail(1002, `unknown opcode ${op}`);
      return;
    }
    if (op === 0 ? !this.#fragging : op > 2 || this.#fragging) return this.#fail(1002, `unexpected opcode ${op}`);
    if (fin && !this.#fragging) return this.#h!.onMessage(data);
    this.#fragging = true;
    this.#frags.push(data);
    this.#fragLen += data.length;
    if (this.#fragLen > MAX_FRAME) return this.#fail(1009, "message too large");
    if (!fin) return;
    const m = Buffer.concat(this.#frags);
    this.#frags = [];
    this.#fragLen = 0;
    this.#fragging = false;
    this.#h!.onMessage(m);
  }

  #fail(code: number, reason: string) {
    if (!this.#sentClose) {
      this.#sentClose = true;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      this.#write(8, p);
    }
    this.#socket.destroy();
    this.#finish(code, reason);
  }

  #finish(code: number, reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#grace) clearTimeout(this.#grace);
    this.#chunks = [];
    this.#frags = [];
    this.#h?.onClose(code, reason);
  }
}
