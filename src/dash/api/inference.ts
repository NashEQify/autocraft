// The accepted models per tier and their effort floors (src/remote/mode.ts). Operators only; changes are audited.
import { acceptedModels, minEfforts, setAcceptedModels } from "../../remote/mode.ts";
import type { Effort, Tier } from "../../remote/protocol.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

/** `mode` is the constant of the dashboard's wire shape: every Claude call runs on a Task Runner. */
export type InferenceSettings = { mode: "user-local"; models: Record<Tier, string[]>; minEffort: Partial<Record<Tier, Effort>> };

export const get = async (db: Db): Promise<InferenceSettings> => ({ mode: "user-local", models: await acceptedModels(db), minEffort: await minEfforts(db) });

/** Body `{models?, minEffort?}`; `minEffort` maps a tier to its lowest effort, or null for none. */
export async function put(db: Db, req: Req): Promise<InferenceSettings> {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change the accepted models");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  const { models, minEffort } = b as { models?: unknown; minEffort?: unknown };
  if (models !== undefined || minEffort !== undefined) {
    try { await setAcceptedModels(db, models, req.user.login, minEffort); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  return await get(db);
}
