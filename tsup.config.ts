import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node-check': 'src/node-check.ts',
    // Run as its own process under pgserve's Bun runtime; daemon.ts finds it
    // next to the bundle.
    'pgserve-launcher': 'src/lib/memory/plugins/embedded-postgres/pgserve-launcher.ts',
  },
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: true,
  shims: true,
  // Keep native/wasm deps out of the bundle so their runtime assets
  // (better-sqlite3's .node, PGlite's vector.tar.gz, pg's pure-TS build,
  // pgserve's bundled Bun runtime + Postgres binaries) resolve from
  // node_modules at import time.
  external: ['better-sqlite3', '@electric-sql/pglite', '@electric-sql/pglite/vector', 'pg', 'pgserve'],
});
