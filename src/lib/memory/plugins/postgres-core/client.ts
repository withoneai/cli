/**
 * Thin Postgres client abstraction.
 *
 * Both node-pg and PGlite implement `query(text, params) => { rows }` with
 * the same `$1`, `$2` parameter binding. This module defines the minimal
 * interface CoreBackend uses so the two drivers can be swapped.
 */

export interface PgClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  /**
   * Run a callback inside a transaction. If the callback throws, the
   * transaction is rolled back. Otherwise it commits.
   *
   * Backends that don't support concurrent writers (e.g. PGlite) may
   * serialize by running each transaction through a queue; the contract
   * remains "all-or-nothing".
   */
  transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number;
}

/**
 * Serialize a JS array of numbers as a pgvector literal. Callers pass the
 * result unchanged as a parameter and cast with `::vector` in the SQL.
 */
export function vectorLiteral(embedding: number[] | null | undefined): string | null {
  if (!embedding || embedding.length === 0) return null;
  return '[' + embedding.join(',') + ']';
}

/**
 * Split a dot-path like "properties.email" into the PG `#>>` path array
 * ({properties,email}) used by JSONB expression indexes + queries.
 */
export function jsonPathArray(dotPath: string): string {
  const parts = dotPath.split('.').map(p => p.replace(/"/g, '""'));
  return '{' + parts.map(p => `"${p}"`).join(',') + '}';
}

/**
 * Build a stable, filesystem-safe index name from a type + jsonPath.
 * Truncates to 63 chars (PG identifier limit).
 */
export function hotColumnIndexName(type: string, jsonPath: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
  const name = `idx_records_${slug(type)}_${slug(jsonPath)}`;
  return name.slice(0, 63);
}

/**
 * Can this database use pgvector? True when the extension is already
 * installed, or when it is available on the server and this login can
 * create it. False otherwise: the store then runs FTS-only and the schema
 * skips the embedding column, instead of failing on `CREATE EXTENSION
 * vector` or on queries that touch a column that was never added.
 */
export async function probePgvector(client: PgClient): Promise<boolean> {
  try {
    const installed = await client.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`,
    );
    if (installed.rows[0]?.ok) return true;
  } catch {
    // Fall through to the create attempt.
  }
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    return true;
  } catch {
    return false;
  }
}
