#!/usr/bin/env node
// `PRAGMA integrity_check` of a libSQL database through libSQL itself (installed in the image as
// /usr/local/bin/factory-sqlite-check, used by factory-snapshot). Stock SQLite cannot parse a schema
// that uses libSQL's own functions, such as a vector index (`libsql_vector_idx`), so it cannot check
// such a file; this uses the @libsql/client the server runs with.
//
//   factory-sqlite-check <database file>
//
// Prints the check's result (`ok` when the file is whole) and exits 0 only on `ok`.
// FACTORY_LIBSQL_FROM names a package.json from which @libsql/client resolves (default: the image's
// @mastra/libsql, /app/stores/libsql/package.json).
import { createRequire } from 'node:module';

const file = process.argv[2];
if (!file) {
  console.error('usage: factory-sqlite-check <database file>');
  process.exit(2);
}
const from = process.env.FACTORY_LIBSQL_FROM || '/app/stores/libsql/package.json';
const { createClient } = createRequire(from)('@libsql/client');

const client = createClient({ url: `file:${file}` });
try {
  const result = await client.execute('PRAGMA integrity_check');
  const lines = result.rows.map(row => String(Object.values(row)[0]));
  console.log(lines.join('\n'));
  process.exitCode = lines.length === 1 && lines[0] === 'ok' ? 0 : 1;
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.close();
}
