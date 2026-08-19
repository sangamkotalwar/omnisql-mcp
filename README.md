# OmniSQL MCP

Universal database MCP server — give AI assistants read/write access to your databases using connections already saved in your local DB client workspace (DBeaver-compatible).

> This is a fork of [srthkdev/omnisql-mcp](https://github.com/srthkdev/omnisql-mcp) that adds SSH tunnel / jump host support. It is **not published to npm** — build it from this repo (see [Installation](#installation)).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

## Database Support

**Natively supported** (direct driver, fast):
- PostgreSQL (via `pg`)
- MySQL / MariaDB (via `mysql2`)
- SQL Server / MSSQL (via `mssql`)
- SQLite (via `sqlite3` CLI)
- Trino / Presto (via `trino-client`)

**Postgres-compatible** (routed through `pg` driver automatically):
- CockroachDB, TimescaleDB, Amazon Redshift, YugabyteDB, AlloyDB, Supabase, Neon, Citus

**Other databases**: Fall back to an external CLI configured via `OMNISQL_CLI_PATH`. Results vary by CLI.

## Features

- Reuses connections already configured in your local DB client workspace — no duplicate setup
- **Automatic SSH tunnel / jump host support**: transparently connects through the same SSH tunnel and gateway/jump host profile configured on the connection (including chained jump servers), no separate tunnel setup needed
- Native query execution for PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Trino/Presto
- Connection pooling with configurable pool size and timeouts (pooling not applicable to SQLite or Trino/Presto, which are connectionless per query)
- Transaction support (BEGIN/COMMIT/ROLLBACK)
- Query execution plan analysis (EXPLAIN)
- Schema comparison between connections with migration script generation
- Read-only mode with enforced SELECT-only on `execute_query`
- Connection whitelist to restrict which databases are accessible
- Tool filtering to disable specific operations
- Query validation to block dangerous operations (DROP DATABASE, TRUNCATE, DELETE/UPDATE without WHERE)
- Data export to CSV/JSON
- Graceful shutdown with connection pool cleanup

## Requirements

- Node.js 18+
- A local DB client (DBeaver-compatible) with at least one configured connection

## Installation

This fork isn't published to npm — build it from source:

```bash
git clone https://github.com/sangameshBB/omnisql-mcp.git
cd omnisql-mcp
npm install
npm run build
```

Then link the built server so the `omnisql-mcp` command points at it:

```bash
npm install -g .
```

> **Do not run `npm install -g omnisql-mcp` on its own.** That installs the original upstream package from the npm registry, which does **not** have SSH tunnel / jump host support. You must clone this repo and build it locally, then run `npm install -g .` from inside the cloned folder as shown above.

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Cursor

Add to Cursor Settings > MCP Servers:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Without a global install

If you'd rather not run `npm install -g .`, point your MCP client directly at the built entry point instead:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "node",
      "args": ["/absolute/path/to/omnisql-mcp/dist/index.js"]
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OMNISQL_CLI_PATH` | Path to external DB client CLI (used for unsupported-driver fallback) | Unset |
| `OMNISQL_WORKSPACE` | Path to local DB client workspace directory | OS default |
| `OMNISQL_TIMEOUT` | Query timeout (ms) | `30000` |
| `OMNISQL_DEBUG` | Enable debug logging | `false` |
| `OMNISQL_READ_ONLY` | Disable all write operations | `false` |
| `OMNISQL_ALLOWED_CONNECTIONS` | Comma-separated whitelist of connection IDs or names | All |
| `OMNISQL_DISABLED_TOOLS` | Comma-separated tools to disable | None |
| `OMNISQL_POOL_MIN` | Minimum connections per pool | `2` |
| `OMNISQL_POOL_MAX` | Maximum connections per pool | `10` |
| `OMNISQL_POOL_IDLE_TIMEOUT` | Idle connection timeout (ms) | `30000` |
| `OMNISQL_POOL_ACQUIRE_TIMEOUT` | Connection acquire timeout (ms) | `10000` |
| `OMNISQL_SSH_PASSWORD` | Fallback SSH password if it can't be read from the workspace | Unset |
| `OMNISQL_SSH_PASSPHRASE` | Fallback SSH private key passphrase | Unset |
| `OMNISQL_SSH_PRIVATE_KEY_PATH` | Fallback SSH private key file path | Unset |

### Read-Only Mode

Blocks all write operations. The `execute_query` tool only allows SELECT, EXPLAIN, SHOW, and DESCRIBE statements. Transaction tools are disabled entirely.

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_READ_ONLY": "true"
      }
    }
  }
}
```

### Connection Whitelist

Restrict which workspace connections are visible. Accepts connection IDs or display names, comma-separated:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_ALLOWED_CONNECTIONS": "dev-postgres,staging-mysql"
      }
    }
  }
}
```

### Disable Specific Tools

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_DISABLED_TOOLS": "drop_table,alter_table,write_query"
      }
    }
  }
}
```

## Available Tools

### Connection Management
- `list_connections` - List all database connections
- `get_connection_info` - Get connection details
- `test_connection` - Test connectivity

### Data Operations
- `execute_query` - Run read-only queries (SELECT, EXPLAIN, SHOW, DESCRIBE only)
- `write_query` - Run INSERT/UPDATE/DELETE
- `export_data` - Export to CSV/JSON

### Schema Management
- `list_tables` - List tables and views
- `get_table_schema` - Get table structure
- `create_table` - Create tables
- `alter_table` - Modify tables
- `drop_table` - Drop tables (requires confirmation)

### Transactions
- `begin_transaction` - Start a new transaction
- `execute_in_transaction` - Execute query within a transaction
- `commit_transaction` - Commit a transaction
- `rollback_transaction` - Roll back a transaction

### Query Analysis
- `explain_query` - Analyze query execution plan
- `compare_schemas` - Compare schemas between two connections
- `get_pool_stats` - Get connection pool statistics

### SSH Tunnel / Jump Host
- `get_ssh_tunnel_info` - Inspect the SSH tunnel / jump host profile associated with a connection (redacted, no secrets)

### Other
- `get_database_stats` - Database statistics
- `append_insight` - Store analysis notes
- `list_insights` - Retrieve stored notes

## Security

- **Read-only enforcement**: `execute_query` only accepts read-only statements (SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA). Write operations must use `write_query`.
- **Query validation**: Blocks DROP DATABASE, DROP SCHEMA, TRUNCATE, DELETE/UPDATE without WHERE, GRANT, REVOKE, and user management statements.
- **Connection whitelist**: Restrict which connections are exposed via `OMNISQL_ALLOWED_CONNECTIONS`.
- **Tool filtering**: Disable any tool via `OMNISQL_DISABLED_TOOLS`.
- **Input sanitization**: Connection IDs and SQL identifiers are sanitized to prevent injection.
- **Recommendation**: For production use, also use a database-level read-only user for defense in depth.

## Workspace Format Support

Supports both configuration formats written by DBeaver-compatible DB clients:
- Legacy: XML config in `.metadata/.plugins/org.jkiss.dbeaver.core/`
- Modern: JSON config in `General/.dbeaver/`

Credentials are automatically decrypted from the workspace `credentials-config.json`.

## SSH Tunnel / Jump Host Support

If a connection has an SSH tunnel (network handler) configured in your DB client — including one or more chained jump servers / gateway hosts — every native query, `test_connection`, transaction, and pooled connection transparently routes through it. No separate tunnel setup is required: the server opens a local port forward through the same SSH hop chain your DB client would use and connects the native driver (`pg`, `mysql2`, `mssql`) to that local endpoint.

- Supports password, public key, and SSH agent authentication per hop
- Supports chained jump servers (`localhost -> jump host(s) -> final SSH host -> database`)
- Tunnels are opened once per connection and reused across queries; closed on shutdown
- Use `get_ssh_tunnel_info` to inspect a connection's tunnel/jump host profile (host, port, auth type, jump server count) without exposing any secrets
- If a password or key passphrase can't be recovered from the workspace's encrypted credential store, set `OMNISQL_SSH_PASSWORD`, `OMNISQL_SSH_PASSPHRASE`, or `OMNISQL_SSH_PRIVATE_KEY_PATH` as a fallback

## Trino / Presto Support

Trino connections work over HTTPS/HTTP (Basic Auth) using the same host/user/password already saved for the connection. A few Trino-specific notes:

- **Catalog/schema are optional.** If the connection has no default catalog/schema configured (common when browsing multiple catalogs in DBeaver), queries must fully qualify tables as `catalog.schema.table`.
- **`list_tables` and `get_table_schema` are catalog-agnostic** by design (via `system.jdbc.tables`/`system.jdbc.columns`), so they work without a default catalog — but on a large multi-catalog cluster this scans metadata across every catalog, which can be slow and may return duplicate rows if the same table name exists in more than one catalog/schema. For a fast, unambiguous lookup, use `execute_query` with `DESCRIBE catalog.schema.table` instead.
- SSH tunneling (above) works the same way for Trino connections as any other driver.
- Trino has no persistent session/transaction model in this server — `begin_transaction` and connection pooling are not available for Trino connections (same as SQLite).

## Development

```bash
git clone https://github.com/sangameshBB/omnisql-mcp.git
cd omnisql-mcp
npm install
npm run build
npm test
npm run lint
```

## License

MIT
