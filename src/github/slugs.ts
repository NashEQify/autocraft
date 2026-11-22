// The GitHub App slugs ever seen, kept in settings so the bot stays ours after the app is replaced or its secrets cannot be read.
import { setting, writeSetting } from "../settings-read.ts";
import type { Db } from "../db/index.ts";

export const SLUGS_KEY = "app_slugs";

export const parseSlugs = (v: string | undefined): string[] => {
  try {
    const a = JSON.parse(v ?? "[]") as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

/** Every app slug ever seen (a slug can only be ours), oldest first. */
export const knownSlugs = async (db: Db): Promise<string[]> => parseSlugs(await setting(db, SLUGS_KEY));

/** Records `slug` in the persisted list when it is new. */
export async function rememberSlug(db: Db, slug: string): Promise<void> {
  // Read from the table, not a pass snapshot: another connection may have recorded a slug since the pass began.
  const known = parseSlugs((await setting(db, SLUGS_KEY)) ?? undefined);
  if (known.includes(slug)) return;
  await writeSetting(db, SLUGS_KEY, JSON.stringify([...known, slug]));
}

/** The names a comment can address the pipeline by: the pipeline login (when recorded) and every known app slug. Mentioning `@<slug>` also covers `@<slug>[bot]`. */
export async function mentionNames(db: Db, extra: string | null = null): Promise<string[]> {
  const box = await setting(db, "pipeline_login");
  return namesOf(box, await knownSlugs(db), extra);
}

/** mentionNames() from the stored pipeline login and the known slugs. */
export const namesOf = (box: string | undefined, slugs: string[], extra: string | null = null): string[] =>
  [...new Set([...(box ? [box] : []), ...slugs, ...(extra ? [extra] : [])])];
