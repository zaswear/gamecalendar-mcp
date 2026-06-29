# gamecalendar-mcp

Servidor **MCP** para la base de datos de GameCalendar (Neon Postgres). Permite a
Claude consultar —y opcionalmente modificar— los datos del sitio directamente,
sin pasar por la web.

## Seguridad: lectura libre, escritura opt-in

- **Lectura**: siempre disponible.
- **Escritura**: solo si defines `GAMECALENDAR_MCP_WRITE=1`. Sin esa variable, las
  tools de escritura **ni se registran** (Claude no puede llamarlas).
- `delete_blog_post` es destructiva y exige `confirm=true` explícito.
- `update_game` solo toca campos editables a mano (`section, score, opencritic_score,
  early_access, trailer`); el resto lo gestiona el sync de IGDB.

## Tools

| Tool | Modo | Qué hace |
|------|------|----------|
| `list_releases` | lectura | Juegos por sección/plataforma |
| `search_games` | lectura | Busca juegos por nombre |
| `get_game` | lectura | Ficha completa (id o slug) |
| `list_blog_posts` | lectura | Posts (con o sin borradores) |
| `get_blog_post` | lectura | Post completo por slug |
| `db_stats` | lectura | Resumen de la DB |
| `create_blog_post` | escritura | Crea post (borrador por defecto) |
| `update_blog_post` | escritura | Edita campos de un post |
| `set_blog_published` | escritura | Publica / despublica |
| `delete_blog_post` | escritura | Borra (requiere `confirm=true`) |
| `update_game` | escritura | Edita campos seguros de un juego |

## Variables de entorno

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | sí | Cadena de conexión Neon (la misma de gamecalendar) |
| `GAMECALENDAR_MCP_WRITE` | no | `1` para habilitar escritura |

## Conectarlo a Claude Code

Con el CLI (recomendado), **solo lectura**:

```bash
claude mcp add gamecalendar \
  --env DATABASE_URL="postgres://...neon..." \
  -- node /home/zaswear/projects/packages/gamecalendar-mcp/index.js
```

Con **escritura** habilitada, añade el flag:

```bash
claude mcp add gamecalendar \
  --env DATABASE_URL="postgres://...neon..." \
  --env GAMECALENDAR_MCP_WRITE=1 \
  -- node /home/zaswear/projects/packages/gamecalendar-mcp/index.js
```

O a mano, en la config MCP (`~/.claude.json` o `.mcp.json` del proyecto):

```json
{
  "mcpServers": {
    "gamecalendar": {
      "command": "node",
      "args": ["/home/zaswear/projects/packages/gamecalendar-mcp/index.js"],
      "env": {
        "DATABASE_URL": "postgres://...neon...",
        "GAMECALENDAR_MCP_WRITE": "1"
      }
    }
  }
}
```

> No pongas la `DATABASE_URL` en ningún archivo commiteado. Pásala por la config MCP
> (que es local) o por el entorno.

## Probar sin Claude

```bash
pnpm -C packages/gamecalendar-mcp smoke          # solo lectura
pnpm -C packages/gamecalendar-mcp smoke --write  # comprueba que registran las tools de escritura
```

El smoke lee `DATABASE_URL` del `.env` de gamecalendar.
