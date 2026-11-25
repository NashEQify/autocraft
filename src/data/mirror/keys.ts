// Constructors of the mirror's named key sources; the resolvers are registered in fragments.ts.
import { namedKeys, type NamedKeys } from "../keys.ts";
import type { OpenItemsArgs } from "./types.ts";

/** Open items, optionally of some repos and one kind; `tracked` limits them to tracked repos. */
export const openItemKeys = (o: OpenItemsArgs = {}): NamedKeys<OpenItemsArgs> => namedKeys("mirror.openItems", o);

/** Items created at or after `from` (ISO time). */
export const itemKeysSince = (from: string): NamedKeys<{ from: string }> => namedKeys("mirror.itemsSince", { from });
