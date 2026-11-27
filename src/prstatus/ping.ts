// The reply that pings the people a status comment's question asks. Edits of the status comment notify nobody and it names them as plain
// logins, so each new question of an item with a status comment gets one short reply comment: the asked people's @-logins beside the
// recommendation line the status comment shows, how to answer and a link to the status comment. A question is the workflow's
// recommendation at its time (`<workflow id>:<rec_at>`, as Discord alerts key it); `pr_status_comments.pinged` keeps the last one pinged,
// so a question is never pinged twice on one item, nor again on an implementation's PR after its issue. An issue's review posts its own
// comment with its recommendation, and an automatic-rule row asks nobody: neither gets a ping.
import { t } from "../i18n/index.ts";
import { loadAccess } from "../data/access/index.ts";
import type { Db } from "../db/index.ts";
import { openQuestion } from "../workflow/asked.ts";
import { recommendationLine } from "../workflow/status.ts";
import type { ItemWorkflow, Recommendation } from "../workflow/types.ts";

export type Ping = { key: string; rec: Recommendation; to: string[] };

/** The open question a ping is due for, or null: none open, an issue review's own, or one `pinged` (the item's keys already pinged) holds. */
export function pingDue(wf: ItemWorkflow, pinged: readonly (string | null | undefined)[]): Ping | null {
  if (wf.kind === "issue" && wf.entry === "review") return null;
  const open = openQuestion(wf);
  if (!open) return null;
  const key = `${wf.id}:${wf.recAt ?? ""}`;
  return pinged.includes(key) ? null : { key, rec: open.rec, to: open.to };
}

/** How to answer, the same words in the status comment and its pings. */
export const answerHow = (slug: string): string => t("Answer in a comment that starts with `@{slug}`: yes, or another command.", { slug });

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;

/** Of `logins`, the GitHub logins of people with an AutoCraft login: no names that are not a GitHub account. */
export async function pingable(db: Db, logins: readonly string[]): Promise<string[]> {
  const shaped = logins.filter((l) => l.length <= 39 && LOGIN.test(l));
  const access = await loadAccess(db, shaped);
  return shaped.filter((l) => access.has(l.toLowerCase()));
}

/** The reply: the pings beside the recommendation line, how to answer, and the link to the status comment (null: none known). */
export function pingBody(to: readonly string[], rec: Recommendation, slug: string | null, link: string | null): string {
  const parts = [`${to.map((l) => `@${l}`).join(" ")} ${recommendationLine(rec)!}`];
  const tail = [slug ? answerHow(slug) : null, link ? t("[Status comment]({link})", { link }) : null].filter((x): x is string => x !== null);
  if (tail.length) parts.push(tail.join(" "));
  return parts.join("\n\n");
}
