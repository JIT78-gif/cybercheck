import { pool } from "./client.ts";

/**
 * Runs `fn` only if no other process (API instance, worker, eval script) holds the same key.
 * A Postgres advisory lock on a dedicated connection: released when done, or automatically if the
 * process dies. Returns false when another process holds it.
 */
export async function withLock(key: string, fn: () => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [key])).rows[0]?.ok;
    if (!got) return false;
    try {
      await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    }
    return true;
  } finally {
    client.release();
  }
}

/** True when nobody holds the lock right now (checked by taking and releasing it). */
export async function isUnlocked(key: string): Promise<boolean> {
  let free = false;
  await withLock(key, async () => {
    free = true;
  });
  return free;
}
