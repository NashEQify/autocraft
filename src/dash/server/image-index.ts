// The image URLs that occur in mirrored issue and PR bodies and comments of
// tracked repos, each with the repos it occurs in. The image proxy serves
// nothing else, so it cannot be used to read arbitrary attachments with the
// bot's token. Built by scanning the mirror, and rebuilt when the mirror has
// changed and the last build is at least `minIntervalMs` old.
import { allowedImage } from "./images.ts";
import type { Db } from "../../db/index.ts";

const URL_RE = /https:\/\/[^\s<>"'`)\]]+/g;
// Cheap row filter so the scan reads only bodies that can hold a proxied image.
const MAY_HAVE_IMAGE = "(body LIKE '%githubusercontent.com%' OR body LIKE '%user-attachments%')";

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
    const r = await this.#db.prepare(`SELECT
      (SELECT value FROM main.settings WHERE key = 'org_high_water') AS hw,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM main.items) AS it,
      (SELECT COUNT(*) FROM main.comments) AS cm,
      (SELECT group_concat(name) FROM main.tracked_repos) AS tr`).get();
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
    for (const table of ["items", "comments"]) {
      const rows = this.#db.prepare(`SELECT t.repo AS repo, t.body AS body FROM main.${table} t
        JOIN main.tracked_repos r ON r.name = t.repo WHERE ${MAY_HAVE_IMAGE.replaceAll("body", "t.body")}`);
      for await (const row of rows.iterate() as AsyncIterable<{ repo: string; body: string | null }>) add(row.repo, row.body);
    }
    this.#built = { sig, at: now, urls };
    return urls;
  }
}
