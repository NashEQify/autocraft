// The image URLs that occur in mirrored issue and PR bodies and comments of
// tracked repos, each with the repos it occurs in. The image proxy serves
// nothing else, so it cannot be used to read arbitrary attachments with the
// bot's token. Built by scanning the mirror, and rebuilt when the mirror has
// changed and the last build is at least `minIntervalMs` old.
import { allowedImage } from "./images.ts";
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";

const URL_RE = /https:\/\/[^\s<>"'`)\]]+/g;
// Cheap row filter so the scan reads only bodies that can hold a proxied image.
const mayHaveImage = (db: Db, eb: kx.Eb) => eb.or([kx.like(db, "t.body", eb.val("%githubusercontent.com%")), kx.like(db, "t.body", eb.val("%user-attachments%"))]);

/** Allowed image hrefs found in `text`. */
export function imageUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = allowedImage(m[0].replace(/&amp;/g, "&").replace(/[.,;:!]+$/, ""));
    if (u) out.push(u.href);
  }
  return out;
}

export class ImageIndex {
  #db: Db;
  #minIntervalMs: number;
  #built: { sig: string; at: number; urls: Map<string, string[]> } | null = null;

  constructor(db: Db, opts: { minIntervalMs?: number } = {}) {
    this.#db = db;
    this.#minIntervalMs = opts.minIntervalMs ?? 30_000;
  }

  /** The tracked repos in which `href` occurs (empty: not allowed). */
  async reposOf(href: string): Promise<string[]> {
    return (await this.#current()).get(href) ?? [];
  }

  async #signature(): Promise<string> {
    const db = this.#db;
    const r = await db.get(db.k.selectNoFrom((eb) => [
      eb.selectFrom("main.settings").select("value").where("key", "=", "org_high_water").as("hw"),
      eb.selectFrom("main.items").select((e) => e.fn.countAll<number>().as("n")).as("itemCount"),
      eb.selectFrom("main.items").select((e) => e.fn.max<string | null>("updated_at").as("m")).as("itemUpdated"),
      eb.selectFrom("main.comments").select((e) => e.fn.countAll<number>().as("n")).as("cm"),
      eb.selectFrom("main.tracked_repos").select(kx.groupConcat(db, "name", ",", "name").as("g")).as("tr"),
    ]));
    return JSON.stringify(r);
  }

  async #current(): Promise<Map<string, string[]>> {
    const now = Date.now();
    if (this.#built && now - this.#built.at < this.#minIntervalMs) return this.#built.urls;
    const sig = await this.#signature();
    if (this.#built && this.#built.sig === sig) {
      this.#built.at = now;
      return this.#built.urls;
    }
    const urls = new Map<string, string[]>();
    const add = (repo: string, body: string | null) => {
      if (!body) return;
      for (const href of imageUrlsIn(body)) {
        const repos = urls.get(href);
        if (!repos) urls.set(href, [repo]);
        else if (!repos.includes(repo)) repos.push(repo);
      }
    };
    const db = this.#db;
    for (const row of await db.all(db.k.selectFrom("main.items as t").innerJoin("main.tracked_repos as r", "r.name", "t.repo")
      .select(["t.repo", "t.body"]).where((eb) => mayHaveImage(db, eb)))) add(row.repo, row.body);
    for (const row of await db.all(db.k.selectFrom("main.comments as t").innerJoin("main.tracked_repos as r", "r.name", "t.repo")
      .select(["t.repo", "t.body"]).where((eb) => mayHaveImage(db, eb)))) add(row.repo, row.body);
    this.#built = { sig, at: now, urls };
    return urls;
  }
}
