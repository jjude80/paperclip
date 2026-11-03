---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

### Embedded cluster credentials and auth

The embedded cluster listens on loopback only, but loopback is a network
boundary, not an identity boundary: every local account can reach the port. So
the cluster password is the access control for the board database.

- Each cluster gets a random password stored at
  `~/.paperclip/instances/default/db/embedded-postgres.password` (mode `0600`).
  It travels with the data directory; back it up and restore it with the
  cluster, and never commit it.
- A cluster created before this behaviour existed (no password file) is rotated
  onto a generated password **once**, by the process that starts the cluster.
  A process that only adopts a running cluster never rotates it.
- On that same owner-only start, `pg_hba.conf` host and local rules that still
  ask for cleartext `password` auth are rewritten to `scram-sha-256` and
  reloaded. This only happens when the stored verifier is provably SCRAM; if the
  rules cannot be proven safe the file is left alone and a warning is logged.
  If a fresh connection with the stored credential fails after the reload, the
  original file is restored and the reload repeated.

**Operator-visible change:** a local script or GUI that connects to the embedded
port with cleartext password auth will be refused after the rewrite. Connect
with the value from the password file (SCRAM) instead. Restoring a pre-upgrade
`pg_hba.conf` reintroduces the cleartext rule; the next owner start rewrites it
again.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If your transaction-mode pooler does not support protocol-level named prepared statements, disable them via the environment:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

For a direct connection or a pooler that supports named prepared statements,
`DATABASE_PREPARED_STATEMENTS=true` also prepares parameterized ORM queries and
queries inside transactions and reserved or dedicated connections. Check the
provider's configuration before you enable it. Preparation caches statement
metadata, not query results. Unset preserves the existing ORM behavior and the
driver default for tagged SQL. Explicit per-query options still apply.

Related optional client tuning: `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_MAX_LIFETIME_SECONDS`, `DATABASE_APPLICATION_NAME`. Driver defaults apply when unset, except that idle pooled connections close after 60 seconds (`DATABASE_IDLE_TIMEOUT_SECONDS=0` keeps them open) and the pool reports `application_name=paperclip`. See [Connection pool settings](#connection-pool-settings).

## Connection Pool Settings

The server opens one postgres.js pool for its own queries (and a second one when `DATABASE_MIGRATION_URL` points at a different connection). Every setting is optional:

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_POOL_MAX` | `10` (driver) | Maximum pooled connections. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | Close a pooled connection after this much idle time. `0` keeps idle connections open forever (the driver default). |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `30` (driver) | Give up on a connection attempt after this long. |
| `DATABASE_MAX_LIFETIME_SECONDS` | 30–60 min, randomized (driver) | Recycle a pooled connection once it is this old. |
| `DATABASE_APPLICATION_NAME` | `paperclip` | Value of `application_name` in `pg_stat_activity`, so you can find Paperclip's backends: `SELECT * FROM pg_stat_activity WHERE application_name = 'paperclip';` |
| `DATABASE_PREPARED_STATEMENTS` | Unset | `true` opts parameterized ORM queries into preparation. `false` disables preparation. Use `false` when the pooler does not support named statements. Unset preserves existing behavior. |

The server ends its pools during shutdown (SIGINT/SIGTERM) and when startup fails after the pool was opened, so a restarting server does not leave idle backends behind. Size `max_connections` on the PostgreSQL side for at least `DATABASE_POOL_MAX` per server process plus your other clients. Each server process also opens up to 2 connections (`application_name=paperclip-controller-lease`) for agent-run lease renewals, so they never queue behind slow application queries; count those too.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
