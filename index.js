#!/usr/bin/env node
// MCP server para la base de datos de GameCalendar (Neon Postgres).
//
//   Lectura  → siempre disponible.
//   Escritura → solo si GAMECALENDAR_MCP_WRITE está activo (guardarraíl opt-in).
//
// Variables de entorno:
//   DATABASE_URL            (obligatoria)  cadena Neon
//   GAMECALENDAR_MCP_WRITE  (opcional)     "1"/"true" habilita las tools de escritura
//
// Transporte: stdio (para Claude Code / Claude Desktop).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[gamecalendar-mcp] DATABASE_URL no definida.');
  process.exit(1);
}
const WRITE_ENABLED = /^(1|true|yes|on)$/i.test(process.env.GAMECALENDAR_MCP_WRITE || '');
const sql = neon(DATABASE_URL);

// Columnas seguras para mostrar un juego en tarjeta.
const GAME_COLS = `id, name, slug, cover, release_date, platforms, genres, score,
  aggregated_rating, opencritic_score, hypes, developer, section, early_access`;

// release_date es epoch (segundos). Añadimos ISO para legibilidad.
const withDate = (g) => g && ({
  ...g,
  release_date_iso: g.release_date ? new Date(g.release_date * 1000).toISOString().slice(0, 10) : null,
});

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e.message); } };

const server = new McpServer({ name: 'gamecalendar', version: '1.0.0' });

/* ───────────────────────── LECTURA ───────────────────────── */

server.registerTool('list_releases', {
  title: 'Listar lanzamientos',
  description: 'Juegos de una sección (upcoming/recent/anticipated/catalog), opcionalmente por plataforma.',
  inputSchema: {
    section: z.enum(['upcoming', 'recent', 'anticipated', 'catalog']).default('upcoming'),
    platform: z.enum(['PC', 'PS5', 'Xbox Series X|S', 'Switch', 'Switch 2']).optional(),
    limit: z.number().int().min(1).max(200).default(30),
    offset: z.number().int().min(0).default(0),
  },
}, wrap(async ({ section, platform, limit, offset }) => {
  const params = [section];
  let where = 'section = $1';
  if (platform) { params.push(JSON.stringify([platform])); where += ` AND platforms @> $${params.length}::jsonb`; }
  params.push(limit, offset);
  const rows = await sql(
    `SELECT ${GAME_COLS} FROM games WHERE ${where}
     ORDER BY release_date ASC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return ok({ section, platform: platform ?? null, count: rows.length, results: rows.map(withDate) });
}));

server.registerTool('search_games', {
  title: 'Buscar juegos',
  description: 'Busca juegos por nombre (coincidencia parcial, insensible a mayúsculas).',
  inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) },
}, wrap(async ({ query, limit }) => {
  const rows = await sql(
    `SELECT ${GAME_COLS} FROM games WHERE name ILIKE $1 ORDER BY hypes DESC NULLS LAST LIMIT $2`,
    [`%${query}%`, limit]
  );
  return ok({ query, count: rows.length, results: rows.map(withDate) });
}));

server.registerTool('get_game', {
  title: 'Detalle de un juego',
  description: 'Ficha completa de un juego por id (número) o slug.',
  inputSchema: { id: z.number().int().optional(), slug: z.string().optional() },
}, wrap(async ({ id, slug }) => {
  if (id == null && !slug) return fail('Indica id o slug.');
  const rows = id != null
    ? await sql('SELECT * FROM games WHERE id = $1 LIMIT 1', [id])
    : await sql('SELECT * FROM games WHERE slug = $1 LIMIT 1', [slug]);
  if (!rows.length) return fail('Juego no encontrado.');
  return ok(withDate(rows[0]));
}));

server.registerTool('list_blog_posts', {
  title: 'Listar posts del blog',
  description: 'Posts del blog. Por defecto solo publicados; include_drafts incluye borradores.',
  inputSchema: { include_drafts: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(50) },
}, wrap(async ({ include_drafts, limit }) => {
  const rows = include_drafts
    ? await sql('SELECT id,slug,title,excerpt,cover_url,published,created_at,updated_at FROM blog_posts ORDER BY created_at DESC LIMIT $1', [limit])
    : await sql('SELECT id,slug,title,excerpt,cover_url,published,created_at,updated_at FROM blog_posts WHERE published = TRUE ORDER BY created_at DESC LIMIT $1', [limit]);
  return ok({ count: rows.length, results: rows });
}));

server.registerTool('get_blog_post', {
  title: 'Detalle de un post',
  description: 'Post del blog completo (incluye body) por slug.',
  inputSchema: { slug: z.string().min(1) },
}, wrap(async ({ slug }) => {
  const rows = await sql('SELECT * FROM blog_posts WHERE slug = $1 LIMIT 1', [slug]);
  if (!rows.length) return fail('Post no encontrado.');
  return ok(rows[0]);
}));

server.registerTool('db_stats', {
  title: 'Estadísticas de la DB',
  description: 'Resumen: total de juegos por sección y nº de posts (publicados/borradores).',
  inputSchema: {},
}, wrap(async () => {
  const bySection = await sql(`SELECT section, COUNT(*)::int AS n FROM games GROUP BY section ORDER BY n DESC`, []);
  const [{ total }] = await sql(`SELECT COUNT(*)::int AS total FROM games`, []);
  const [{ published }] = await sql(`SELECT COUNT(*)::int AS published FROM blog_posts WHERE published = TRUE`, []);
  const [{ drafts }] = await sql(`SELECT COUNT(*)::int AS drafts FROM blog_posts WHERE published = FALSE`, []);
  return ok({ games_total: total, games_by_section: bySection, blog_published: published, blog_drafts: drafts, write_enabled: WRITE_ENABLED });
}));

/* ───────────────────────── ESCRITURA (opt-in) ───────────────────────── */

if (WRITE_ENABLED) {
  server.registerTool('create_blog_post', {
    title: 'Crear post (borrador)',
    description: 'Crea un post del blog. Por defecto como borrador (published=false).',
    inputSchema: {
      slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'slug en kebab-case'),
      title: z.string().min(1),
      body: z.string().min(1),
      excerpt: z.string().optional(),
      cover_url: z.string().url().optional(),
      published: z.boolean().default(false),
    },
  }, wrap(async ({ slug, title, body, excerpt, cover_url, published }) => {
    const dupe = await sql('SELECT 1 FROM blog_posts WHERE slug = $1 LIMIT 1', [slug]);
    if (dupe.length) return fail(`Ya existe un post con slug "${slug}".`);
    const rows = await sql(
      `INSERT INTO blog_posts (slug, title, body, excerpt, cover_url, published)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, slug, title, published, created_at`,
      [slug, title, body, excerpt ?? null, cover_url ?? null, published]
    );
    return ok({ created: rows[0] });
  }));

  server.registerTool('update_blog_post', {
    title: 'Editar post',
    description: 'Actualiza campos de un post existente (por slug). Solo se cambian los campos enviados.',
    inputSchema: {
      slug: z.string().min(1),
      title: z.string().optional(),
      body: z.string().optional(),
      excerpt: z.string().optional(),
      cover_url: z.string().url().optional(),
    },
  }, wrap(async ({ slug, ...fields }) => {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (!entries.length) return fail('No hay campos que actualizar.');
    const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
    const params = entries.map(([, v]) => v);
    params.push(slug);
    const rows = await sql(
      `UPDATE blog_posts SET ${sets.join(', ')}, updated_at = NOW() WHERE slug = $${params.length}
       RETURNING id, slug, title, published, updated_at`,
      params
    );
    if (!rows.length) return fail('Post no encontrado.');
    return ok({ updated: rows[0] });
  }));

  server.registerTool('set_blog_published', {
    title: 'Publicar / despublicar post',
    description: 'Cambia el estado de publicación de un post.',
    inputSchema: { slug: z.string().min(1), published: z.boolean() },
  }, wrap(async ({ slug, published }) => {
    const rows = await sql(
      'UPDATE blog_posts SET published = $1, updated_at = NOW() WHERE slug = $2 RETURNING slug, published',
      [published, slug]
    );
    if (!rows.length) return fail('Post no encontrado.');
    return ok({ updated: rows[0] });
  }));

  server.registerTool('delete_blog_post', {
    title: 'Borrar post',
    description: 'Elimina un post. DESTRUCTIVO: requiere confirm=true explícito.',
    inputSchema: { slug: z.string().min(1), confirm: z.boolean().default(false) },
  }, wrap(async ({ slug, confirm }) => {
    if (!confirm) return fail('Operación destructiva: vuelve a llamar con confirm=true para borrar.');
    const rows = await sql('DELETE FROM blog_posts WHERE slug = $1 RETURNING slug', [slug]);
    if (!rows.length) return fail('Post no encontrado.');
    return ok({ deleted: rows[0].slug });
  }));

  // Edición de juegos limitada a campos seguros (los demás los sincroniza IGDB).
  const GAME_EDITABLE = ['section', 'score', 'opencritic_score', 'early_access', 'trailer'];
  server.registerTool('update_game', {
    title: 'Editar juego (campos seguros)',
    description: `Actualiza un juego por id. Solo campos editables a mano: ${GAME_EDITABLE.join(', ')}. El resto lo gestiona el sync de IGDB.`,
    inputSchema: {
      id: z.number().int(),
      section: z.enum(['upcoming', 'recent', 'anticipated', 'catalog']).optional(),
      score: z.number().optional(),
      opencritic_score: z.number().optional(),
      early_access: z.boolean().optional(),
      trailer: z.string().optional(),
    },
  }, wrap(async ({ id, ...fields }) => {
    const entries = Object.entries(fields).filter(([k, v]) => v !== undefined && GAME_EDITABLE.includes(k));
    if (!entries.length) return fail('No hay campos editables que actualizar.');
    const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
    const params = entries.map(([, v]) => v);
    params.push(id);
    const rows = await sql(
      `UPDATE games SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, section, score, opencritic_score, early_access`,
      params
    );
    if (!rows.length) return fail('Juego no encontrado.');
    return ok({ updated: rows[0] });
  }));
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[gamecalendar-mcp] listo. Escritura: ${WRITE_ENABLED ? 'HABILITADA' : 'deshabilitada (solo lectura)'}.`);
