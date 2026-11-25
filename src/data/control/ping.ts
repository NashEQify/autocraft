import type { Db } from "../../db/index.ts";

/** True when the database answers a trivial query. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.get(db.k.selectNoFrom((eb) => eb.lit(1).as("one")));
    return true;
  } catch {
    return false;
  }
}
