// Conversations with the model on fake data: one thread with each kind of card, an empty one everywhere else.
import type { Api } from "../client";
import type { Conversation, ConversationCard, ConversationTurn, User } from "../types";
import { NOW } from "./fixtures";

const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const card = (c: Pick<ConversationCard, "id" | "kind" | "headline" | "label" | "steps"> & Partial<ConversationCard>): ConversationCard => ({ title: c.headline, canSettle: true, digest: `d${c.id}`, state: "proposed", ...c });

const THREAD: ConversationTurn[] = [
  { id: 1, kind: "operator", login: "mosswood", at: at(50), body: "Most of this diff is dictionary data. Do we already ship it?", actions: [], notes: [], status: "answered" },
  {
    id: 2, kind: "opus", login: "opus", at: at(46), body: "Yes. The `hu` language pack carries the same dictionary and hyphenation patterns, so the committed files can go and the spellchecker can load the pack.", notes: [],
    actions: [
      card({ id: 11, kind: "command", headline: "Fix up and merge", label: "Fix up and merge", command: "fix-up and merge", writes: "merges the PR on GitHub once the review and CI pass",
        steps: ["Fix up the PR, then merge it if the review and CI pass", 'After the merge: open an issue in craft-i18n: "Load Hungarian from the language pack"'] }),
      card({ id: 12, kind: "comment", headline: "Post comment", label: "Post comment", steps: ["Post the comment below"], text: "Thanks for the Hungarian work. I'm pushing a change that loads the language pack instead of the committed data, then merging." }),
      card({ id: 13, kind: "label", headline: "Add label", label: "Add label", steps: ['Add the label "missing feature"'] }),
      card({ id: 14, kind: "command", headline: "Open issue in craft-i18n", label: "Open issue", steps: ['Open an issue in craft-i18n: "Load Hungarian from the language pack"'], refusal: "AutoCraft has no command to open an issue; do it on GitHub" }),
      card({ id: 15, kind: "label", headline: "Remove label", label: "Remove label", steps: ['Remove the label "bugfix"'], state: "done", by: "mosswood", at: at(40), done: { at: at(40), link: "", label: "Label removed" } }),
    ],
  },
];

export function createConversationMock(me: User, changed: () => void): Pick<Api, "conversations"> {
  const wait = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
  const threads = new Map<string, ConversationTurn[]>([["designcraft#1484", structuredClone(THREAD)]]);
  let nextId = 100;
  const canTalk = (repo: string) => me.role === "operator" || (me.role === "maintainer" && me.writeRepos.includes(repo));
  const view = (repo: string, number: number): Conversation => {
    const turns = threads.get(`${repo}#${number}`);
    const may = canTalk(repo);
    return { repo, number, exists: !!turns, pending: false, canTalk: may, canWithdraw: false, startedBy: turns?.[0]?.login ?? null, turns: (turns ?? []).map((x) => ({ ...x, actions: x.actions.map((a) => ({ ...a, canSettle: may })) })) };
  };
  const find = (id: number): ConversationCard => {
    for (const turns of threads.values()) for (const x of turns) for (const a of x.actions) if (a.id === id) return a;
    throw new Error("no such card");
  };
  const set = (id: number, patch: Partial<ConversationCard>) => {
    const a = Object.assign(find(id), patch);
    changed();
    return wait(a, 30);
  };
  return {
    conversations: {
      get: (repo, number) => wait(view(repo, number)),
      say(repo, number, text, ask) {
        const k = `${repo}#${number}`;
        const turns = threads.get(k) ?? threads.set(k, []).get(k)!;
        turns.push({ id: nextId++, kind: me.role === "operator" ? "operator" : "maintainer", login: me.login, at: new Date(NOW).toISOString(), body: text, actions: [], notes: [], ...(ask !== false && { status: "answered" as const }) });
        if (ask !== false) turns.push({ id: nextId++, kind: "opus", login: "opus", at: new Date(NOW).toISOString(), body: "I read that. The pack loads before the spellchecker starts, so the order is safe.", actions: [], notes: [] });
        changed();
        return wait(view(repo, number), 200);
      },
      withdraw: (repo, number) => wait(view(repo, number)),
      editCard: (id, edit) => set(id, { ...(edit.text !== undefined && { text: edit.text }), edited: true, editedBy: me.login, digest: `d${id}-${nextId++}` }),
      doCard: (id, digest) => {
        if (find(id).digest !== digest) return Promise.reject(new Error("the card changed; look at it again"));
        return set(id, { state: "done", by: me.login, at: new Date(NOW).toISOString(), done: { at: new Date(NOW).toISOString(), link: "", label: "Done" } });
      },
      dismissCard: (id) => set(id, { state: "dismissed", by: me.login, at: new Date(NOW).toISOString() }),
    },
  };
}
