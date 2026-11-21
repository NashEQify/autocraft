// The inference mode and the accepted models per tier of the user-local mode (src/remote/mode.ts). Operators only; changes are audited.
import { acceptedModels, inferenceMode, minEfforts, isInferenceMode, setAcceptedModels, setInferenceMode, type InferenceMode } from "../../remote/mode.ts";
import type { Effort, Tier } from "../../remote/protocol.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

export type InferenceSettings = { mode: InferenceMode; models: Record<Tier, string[]>; minEffort: Partial<Record<Tier, Effort>> };

export const get = async (db: Db): Promise<InferenceSettings> => ({ mode: await inferenceMode(db), models: await acceptedModels(db), minEffort: await minEfforts(db) });

/** Body `{mode?, models?, minEffort?}`; `minEffort` maps a tier to its lowest effort, or null for none. */
export async function put(db: Db, req: Req): Promise<InferenceSettings> {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change the inference mode");
  const b = req.json;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  const { mode, models, minEffort } = b as { mode?: unknown; models?: unknown; minEffort?: unknown };
  if (mode !== undefined && !isInferenceMode(mode)) throw new HttpError(400, "mode must be server or user-local");
  if (models !== undefined || minEffort !== undefined) {
    try { await setAcceptedModels(db, models, req.user.login, minEffort); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (mode !== undefined) await setInferenceMode(db, mode, req.user.login);
  return await get(db);
}
