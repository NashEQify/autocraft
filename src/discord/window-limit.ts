// Sliding-window counters kept in memory, keyed by keyed hashes (never plain ids).
export type WindowRule = { key: string; n: number; ms: number };

export class WindowLimits {
  #hits = new Map<string, number[]>();

  /** All or nothing: when every rule has room for `cost` more hits they are counted and true is returned; otherwise nothing is counted and `over` (if given) gets the first rule that is full. */
  allow(now: number, rules: WindowRule[], cost = 1, over?: (r: WindowRule) => void): boolean {
    const live = rules.map((r) => (this.#hits.get(r.key) ?? []).filter((t) => now - t < r.ms));
    const full = rules.findIndex((r, i) => live[i]!.length + cost > r.n);
    if (full < 0) live.forEach((l) => { for (let i = 0; i < cost; i++) l.push(now); });
    rules.forEach((r, i) => this.#hits.set(r.key, live[i]!));
    for (const [k, v] of this.#hits) if (!v.length) this.#hits.delete(k);
    if (full >= 0) over?.(rules[full]!);
    return full < 0;
  }
}
