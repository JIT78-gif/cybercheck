import pg from "pg";

export interface Database {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
  });

  // Errors on idle clients must not crash the process.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return {
    async ping() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
