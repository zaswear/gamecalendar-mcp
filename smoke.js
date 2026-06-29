// Smoke test end-to-end: arranca el MCP por stdio, lista tools y ejecuta lecturas
// reales contra la DB. Lee DATABASE_URL del .env de gamecalendar.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return out;
}

const env = loadEnv(join(__dirname, '..', 'gamecalendar', '.env'));
const DATABASE_URL = process.env.DATABASE_URL || env.DATABASE_URL;
if (!DATABASE_URL) { console.error('sin DATABASE_URL'); process.exit(1); }

const withWrite = process.argv.includes('--write');

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(__dirname, 'index.js')],
  env: { ...process.env, DATABASE_URL, ...(withWrite ? { GAMECALENDAR_MCP_WRITE: '1' } : {}) },
});

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\nTools expuestas (${tools.length})${withWrite ? ' [write ON]' : ' [solo lectura]'}:`);
console.log('  ' + tools.map(t => t.name).join(', '));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? '';
  return r.isError ? `ERROR: ${txt}` : txt;
};

console.log('\n── db_stats ──');
console.log(await call('db_stats'));

console.log('\n── search_games "zelda" (2) ──');
const s = JSON.parse(await call('search_games', { query: 'zelda', limit: 2 }));
console.log(`  ${s.count} resultados; primero: ${s.results[0]?.name} (${s.results[0]?.release_date_iso})`);

console.log('\n── list_releases upcoming (3) ──');
const r = JSON.parse(await call('list_releases', { section: 'upcoming', limit: 3 }));
console.log('  ' + r.results.map(g => `${g.name} [${g.release_date_iso}]`).join('\n  '));

await client.close();
console.log('\n✅ smoke OK');
process.exit(0);
