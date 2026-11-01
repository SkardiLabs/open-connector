import type { IConnectionStore, StoredConnection, StoredLocalConnection } from "../../connection-store.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";

import { HttpRequestError } from "../api/http-utils.ts";
import {
  initializeRetirement,
  lockRetirement,
  retirementMatches,
  temporaryAliasAvailable,
} from "./connection-retirement.ts";
import { queueSaasConnections, readSaasConnection } from "./saas-project-store.ts";

/** Exact expired authorization selected before decoding; retirement rechecks it under its lock. */
export interface ExpiredOAuthState {
  state: string;
  value: string;
  cutoff: string;
  retirementGeneration: string;
}

/** Connection writes share the request transaction so replacing/deleting remote references cannot lose cleanup work. */
export class SqlConnectionStore implements IConnectionStore {
  private readonly transaction: RequestTransaction;
  private readonly codec: ISecretCodec;

  constructor(transaction: RequestTransaction, codec: ISecretCodec) {
    this.transaction = transaction;
    this.codec = codec;
  }

  private async read(row: RuntimeRow): Promise<StoredConnection> {
    if (row.source === "saas") return readSaasConnection(row, this.codec);
    return {
      id: row.id as string,
      revision: row.revision as string,
      service: row.service as string,
      connectionName: row.connection_name as string,
      credential: JSON.parse(await this.codec.decode(row.value as string)) as ResolvedCredential,
    };
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const [[row]] = await this.transaction([
      {
        sql: "select * from connections where service = ? and connection_name = ?",
        values: [service, connectionName],
      },
    ]);
    return row ? this.read(row) : undefined;
  }

  async list(): Promise<StoredConnection[]> {
    const [rows] = await this.transaction([
      { sql: "select * from connections order by service, connection_name", values: [] },
    ]);
    return Promise.all(rows.map((row) => this.read(row)));
  }

  async getRetirementGeneration(service: string, connectionName: string): Promise<string> {
    const [, [row]] = await this.transaction([
      initializeRetirement(service, connectionName, crypto.randomUUID()),
      {
        sql: "select generation from connection_retirements where service = ? and connection_name = ?",
        values: [service, connectionName],
      },
    ]);
    return row.generation as string;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredLocalConnection> {
    const stored = await this.writeCredential(service, connectionName, credential);
    if (!stored) throw new Error("Connection upsert did not return the stored row.");
    return stored;
  }

  async setIfCurrentGeneration(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
    retirementGeneration: string,
  ): Promise<StoredLocalConnection | undefined> {
    return this.writeCredential(service, connectionName, credential, retirementGeneration);
  }

  private async writeCredential(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
    retirementGeneration?: string,
  ): Promise<StoredLocalConnection | undefined> {
    const fence =
      retirementGeneration === undefined
        ? { sql: "1 = 1", values: [] }
        : retirementMatches(service, connectionName, retirementGeneration);
    const authorization =
      credential.authType === "oauth2" && credential.metadata.linkOnly !== undefined
        ? credential.metadata.oauthAuthorizationId
        : undefined;
    const reservation = temporaryAliasAvailable(
      service,
      connectionName,
      typeof authorization === "string" ? `cleanup:${authorization}` : "",
    );
    const value = await this.codec.encode(JSON.stringify(credential));
    const [, [accepted], [available], , , [row]] = await this.transaction([
      initializeRetirement(service, connectionName, crypto.randomUUID()),
      retirementGeneration === undefined
        ? {
            sql: "update connection_retirements set generation = generation where service = ? and connection_name = ? returning generation",
            values: [service, connectionName],
          }
        : lockRetirement(service, connectionName, retirementGeneration),
      { sql: `select 1 where ${reservation.sql}`, values: reservation.values },
      {
        sql: "update connections set revision = revision where service = ? and connection_name = ?",
        values: [service, connectionName],
      },
      queueSaasConnections(`service = ? and connection_name = ? and ${fence.sql} and ${reservation.sql}`, [
        service,
        connectionName,
        ...fence.values,
        ...reservation.values,
      ]),
      {
        sql: `insert into connections (id, revision, service, connection_name, value, updated_at, provider_account_id)
          select ?, ?, ?, ?, ?, ?, ? where ${fence.sql} and ${reservation.sql} on conflict (service, connection_name) do update set
          revision = excluded.revision, value = excluded.value, updated_at = excluded.updated_at,
          source = 'local', managed_project_id = null, provider_config_id = null, external_user_id = null,
          remote_account_id = null, local_request_id = null, provider_account_id = excluded.provider_account_id
          where not exists (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))
          or (connections.provider_account_id is not null and connections.provider_account_id = excluded.provider_account_id) returning id, revision`,
        values: [
          crypto.randomUUID(),
          crypto.randomUUID(),
          service,
          connectionName,
          value,
          new Date().toISOString(),
          credential.authType !== "no_auth" && credential.metadata.providerAccountVerified === true
            ? credential.profile.accountId
            : null,
          ...fence.values,
          ...reservation.values,
        ],
      },
    ]);
    if (!accepted) return undefined;
    if (!available)
      throw new HttpRequestError("connection_reserved", "An identity authorization owns this alias.", 409);
    if (!row)
      throw new HttpRequestError(
        "connection_has_subscriptions",
        "Cancel or abandon remote Trigger subscriptions before replacing this connection.",
        409,
      );
    return { id: row.id as string, revision: row.revision as string, service, connectionName, credential };
  }

  async updateCredential(input: StoredLocalConnection, refresh = false): Promise<boolean> {
    const value = await this.codec.encode(JSON.stringify(input.credential));
    const [, [row]] = await this.transaction([
      { sql: "update connections set revision = revision where id = ?", values: [input.id] },
      {
        sql: `update connections set revision = ?, value = ?, updated_at = ?, provider_account_id = ?
        where service = ? and connection_name = ? and id = ? and revision = ? and source = 'local'
        and (? = 1 or not exists (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))
        or (provider_account_id is not null and provider_account_id = ?)) returning id`,
        values: [
          crypto.randomUUID(),
          value,
          new Date().toISOString(),
          input.credential.authType !== "no_auth" && input.credential.metadata.providerAccountVerified === true
            ? input.credential.profile.accountId
            : null,
          input.service,
          input.connectionName,
          input.id,
          input.revision,
          refresh ? 1 : 0,
          input.credential.authType !== "no_auth" && input.credential.metadata.providerAccountVerified === true
            ? input.credential.profile.accountId
            : null,
        ],
      },
    ]);
    return row !== undefined;
  }

  async delete(service: string, connectionName: string, expected?: ExpiredOAuthState | string): Promise<void> {
    const conditional = expected !== undefined;
    const expired = typeof expected === "object" ? expected : undefined;
    const expectedGeneration = typeof expected === "string" ? expected : expired?.retirementGeneration;
    const generation = crypto.randomUUID();
    const fence = conditional ? retirementMatches(service, connectionName, generation) : { sql: "1 = 1", values: [] };
    const deletable =
      "not exists (select 1 from trigger_subscriptions where connection_id = connections.id and mode <> 'resource-set' and status in ('active', 'deleting'))";
    const retired = "not exists (select 1 from connections where service = ? and connection_name = ?)";
    const results = await this.transaction([
      initializeRetirement(service, connectionName, crypto.randomUUID()),
      conditional ? lockRetirement(service, connectionName, expectedGeneration!) : { sql: "select 1", values: [] },
      conditional
        ? {
            // Claim only the exact still-expired state. The new ordinary retirement
            // generation gates every following deletion in this same transaction.
            sql: `update connection_retirements set generation = ? where service = ? and connection_name = ? and generation = ?
          ${expired ? "and exists (select 1 from oauth_states where state = ? and value = ? and created_at < ?)" : ""}
          and not exists (select 1 from connections where service = ? and connection_name = ? and not (${deletable}))`,
            values: [
              generation,
              service,
              connectionName,
              expectedGeneration!,
              ...(expired ? [expired.state, expired.value, expired.cutoff] : []),
              service,
              connectionName,
            ],
          }
        : {
            sql: "update connection_retirements set generation = generation where service = ? and connection_name = ?",
            values: [service, connectionName],
          },
      {
        sql: `update connections set revision = revision where service = ? and connection_name = ? and ${fence.sql}`,
        values: [service, connectionName, ...fence.values],
      },
      queueSaasConnections(`service = ? and connection_name = ? and ${fence.sql}`, [
        service,
        connectionName,
        ...fence.values,
      ]),
      {
        sql: `delete from connections where service = ? and connection_name = ? and ${fence.sql} and ${deletable}`,
        values: [service, connectionName, ...fence.values],
      },
      conditional
        ? { sql: "select 1", values: [] }
        : {
            sql: `update connection_retirements set generation = ? where service = ? and connection_name = ? and ${retired}`,
            values: [generation, service, connectionName, service, connectionName],
          },
      {
        sql: `delete from oauth_states where service = ? and connection_name = ? and ${fence.sql} and ${retired}`,
        values: [service, connectionName, ...fence.values, service, connectionName],
      },
      {
        sql: `update connection_requests set phase = 'completed', status = 'failed', error_code = 'connection_retired',
          error_message = 'The connection was disconnected during authorization.', value = null, updated_at = ?
          where kind = 'local' and service = ? and connection_name = ? and phase in ('pending', 'processing') and ${fence.sql} and ${retired}`,
        values: [Date.now(), service, connectionName, ...fence.values, service, connectionName],
      },
      {
        sql: `select id from connections where service = ? and connection_name = ? and ${fence.sql}`,
        values: [service, connectionName, ...fence.values],
      },
    ]);
    if (results.at(-1)![0])
      throw new HttpRequestError(
        "connection_has_subscriptions",
        "Cancel or abandon remote Trigger subscriptions before disconnecting this connection.",
        409,
      );
  }
}
