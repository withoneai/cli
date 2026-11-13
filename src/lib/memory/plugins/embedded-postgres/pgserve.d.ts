/**
 * The part of pgserve 2.2.3's PostgresManager that pgserve-launcher uses.
 * pgserve ships no type declarations. `adminPool` is a Bun.sql client and
 * `_initAdminPool` is internal; both are pinned by the exact pgserve version
 * in package.json, so re-check them when upgrading.
 */
declare module 'pgserve' {
  export interface PostgresManagerOptions {
    dataDir?: string;
    port?: number;
    user?: string;
    password?: string;
    logger: unknown;
    enablePgvector?: boolean;
  }

  export class PostgresManager {
    constructor(options: PostgresManagerOptions);
    password: string;
    adminPool: { unsafe(sql: string): Promise<unknown>; close(): Promise<void> };
    process: { exited: Promise<number> } | null;
    start(): Promise<this>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    _initAdminPool(): Promise<void>;
  }
}
