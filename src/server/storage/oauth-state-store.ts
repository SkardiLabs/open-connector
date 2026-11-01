import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { RequestTransaction } from "./connection-request-store.ts";

import { normalizeConnectionName } from "../../connection-service.ts";
import {
  initializeRetirement,
  lockRetirement,
  retirementMatches,
  temporaryAliasAvailable,
} from "./connection-retirement.ts";
import { SqlConnectionStore } from "./connection-store.ts";

/** Pending OAuth state shares the same durable fence and transaction as credential retirement. */
export class SqlOAuthStateStore implements IOAuthStateStore {
  private readonly transaction: RequestTransaction;
  private readonly codec: ISecretCodec;

  constructor(transaction: RequestTransaction, codec: ISecretCodec) {
    this.transaction = transaction;
    this.codec = codec;
  }

  async deleteCreatedBefore(cutoff: string): Promise<void> {
    const [rows] = await this.transaction([
      {
        sql: "select state, value from oauth_states where created_at < ? order by created_at limit 100",
        values: [cutoff],
      },
    ]);
    for (const row of rows) {
      const expired = JSON.parse(await this.codec.decode(row.value as string)) as OAuthAuthorizationState;
      if (expired.linkOnly) {
        // Same fence as explicit disconnect: an in-flight callback cannot
        // publish after this deletion, including across process restarts.
        await new SqlConnectionStore(this.transaction, this.codec).delete(
          expired.service,
          normalizeConnectionName(expired.connectionName),
          {
            state: row.state as string,
            value: row.value as string,
            cutoff,
            retirementGeneration: expired.retirementGeneration,
          },
        );
      } else {
        await this.transaction([
          { sql: "delete from oauth_states where state = ? and created_at < ?", values: [row.state as string, cutoff] },
        ]);
      }
    }
  }

  async set(state: OAuthAuthorizationState): Promise<boolean> {
    const connectionName = normalizeConnectionName(state.connectionName);
    const value = await this.codec.encode(JSON.stringify(state));
    const fence = retirementMatches(state.service, connectionName, state.retirementGeneration);
    const reservation = temporaryAliasAvailable(state.service, connectionName, state.cleanupOnly ? state.state : "");
    const [, , [accepted]] = await this.transaction([
      initializeRetirement(state.service, connectionName, state.retirementGeneration),
      lockRetirement(state.service, connectionName, state.retirementGeneration),
      {
        sql: `insert into oauth_states (state, value, created_at, service, connection_name)
        select ?, ?, ?, ?, ? where ${fence.sql} and ${reservation.sql}
        ${state.linkOnly && !state.cleanupOnly ? "and not exists (select 1 from oauth_states where service = ? and connection_name = ?) and not exists (select 1 from connections where service = ? and connection_name = ?) and not exists (select 1 from connection_requests where kind = 'local' and service = ? and connection_name = ? and phase in ('pending', 'processing') and expires_at > ?)" : ""}
        on conflict(state) do update set value = excluded.value, created_at = excluded.created_at,
          service = excluded.service, connection_name = excluded.connection_name returning state`,
        values: [
          state.state,
          value,
          state.createdAt,
          state.service,
          connectionName,
          ...fence.values,
          ...reservation.values,
          ...(state.linkOnly && !state.cleanupOnly
            ? [
                state.service,
                connectionName,
                state.service,
                connectionName,
                state.service,
                connectionName,
                state.createdAt,
              ]
            : []),
        ],
      },
    ]);
    return accepted !== undefined;
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const [[row]] = await this.transaction([
      state.startsWith("link_")
        ? {
            // Keep the existing cleanup artifact as the alias reservation while
            // exchanging the token; ordinary popup take remains destructive.
            sql: "update oauth_states set state = ? where state = ? returning value",
            values: [`cleanup:${state}`, state],
          }
        : { sql: "delete from oauth_states where state = ? returning value", values: [state] },
    ]);
    return row ? (JSON.parse(await this.codec.decode(row.value as string)) as OAuthAuthorizationState) : undefined;
  }
}
