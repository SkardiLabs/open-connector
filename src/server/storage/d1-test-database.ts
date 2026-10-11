import type { D1DatabaseBinding, D1PreparedStatementBinding } from "../cloudflare/cloudflare-bindings.ts";

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** SQLite-backed D1 driver fixture; batches obey D1's transaction contract. */
export class SqliteD1Database implements D1DatabaseBinding {
  private readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(readFileSync(new URL("../../../migrations/0001_runtime.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../migrations/0002_run_service.sql", import.meta.url), "utf8"));
    this.database.exec(
      readFileSync(new URL("../../../migrations/0003_action_idempotency.sql", import.meta.url), "utf8"),
    );
    this.database.exec(readFileSync(new URL("../../../migrations/0004_action_run_audit.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../migrations/0005_run_retention.sql", import.meta.url), "utf8"));
    this.database.exec(
      readFileSync(new URL("../../../migrations/0006_connection_identity.sql", import.meta.url), "utf8"),
    );
    this.database.exec(readFileSync(new URL("../../../migrations/0007_runtime_policy.sql", import.meta.url), "utf8"));
    this.database.exec(
      readFileSync(new URL("../../../migrations/0008_runtime_token_policy.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../migrations/0009_runtime_token_proxy.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../migrations/0010_connection_revision.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../migrations/0011_runtime_token_connection_scope.sql", import.meta.url), "utf8"),
    );
    this.database.exec(
      readFileSync(new URL("../../../migrations/0013_connection_retirement.sql", import.meta.url), "utf8"),
    );
  }

  async batch(statements: D1PreparedStatementBinding[]): Promise<unknown[]> {
    this.database.exec("begin immediate");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("commit");
      return results;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  prepare(query: string): D1PreparedStatementBinding {
    return new SqliteD1PreparedStatement(this.database, query);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  value(
    table: "connections" | "oauth_client_configs" | "oauth_states" | "idempotency_records",
    keyColumn: "service" | "state" | "key_hash",
    key: string,
    valueColumn: "value" | "response_value" = "value",
  ): string {
    const row = this.database.prepare(`select ${valueColumn} from ${table} where ${keyColumn} = ?`).get(key) as
      | Record<string, string>
      | undefined;
    return row?.[valueColumn] ?? "";
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatementBinding {
  private readonly database: DatabaseSync;
  private readonly query: string;
  private readonly values: unknown[];

  constructor(database: DatabaseSync, query: string, values: unknown[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementBinding {
    return new SqliteD1PreparedStatement(this.database, this.query, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...toSqlValues(this.values)) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.query).all(...toSqlValues(this.values)) as T[] };
  }

  async run(): Promise<{ success: boolean; meta: { changes?: number } }> {
    const result = this.database.prepare(this.query).run(...toSqlValues(this.values));
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function toSqlValues(values: unknown[]): Array<string | number | bigint | null | Uint8Array> {
  return values.map((value) => (value === undefined ? null : (value as string | number | bigint | null | Uint8Array)));
}
