import type {
  TenantDataAccessAuthority,
  TenantDataAccessGrant,
  TenantDataBrokerAttemptStore,
  TenantDataBrokerEffectResolution,
  TenantDataBrokerEffectResolver,
  TenantDataOperation,
} from '@aeostudio/application/tenant-data-access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_OBJECT_BYTES = 2 * 1_024 * 1_024 * 1_024;

const TENANT_DATA_OPERATIONS = new Set<TenantDataOperation>([
  'READ_CONNECTOR_SECRET',
  'DESCRIBE_CONNECTOR_SECRET',
  'VERIFY_CONNECTOR_SECRET_UNREADABLE',
  'DELETE_CONNECTOR_SECRET',
  'PUT_WORKLOAD_OBJECT',
  'READ_WORKLOAD_OBJECT',
  'HEAD_WORKLOAD_OBJECT',
  'DELETE_WORKLOAD_OBJECT_VERSION',
  'PUT_PRIVACY_OBJECT',
  'READ_PRIVACY_OBJECT',
  'HEAD_PRIVACY_OBJECT',
  'LIST_TENANT_OBJECT_VERSIONS',
  'DELETE_PRIVACY_OBJECT_VERSION',
  'GET_OBJECT_LEGAL_HOLD',
  'SET_OBJECT_LEGAL_HOLD',
]);

export interface TenantDataBrokerSqlClient {
  query(statement: string, values: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

type DatabaseRecord = Record<string, unknown>;

export class PostgresTenantDataBrokerStore
  implements TenantDataAccessAuthority, TenantDataBrokerAttemptStore, TenantDataBrokerEffectResolver
{
  public constructor(private readonly database: TenantDataBrokerSqlClient) {}

  public async loadActiveGrant(input: {
    capabilityId: string;
    leaseToken: string;
    at: Date;
  }): Promise<TenantDataAccessGrant | null> {
    requireUuid(input.capabilityId);
    requireUuid(input.leaseToken);
    requireDate(input.at);
    const result = await this.database.query(
      `SELECT *
         FROM load_active_tenant_data_capability($1, $2)`,
      [input.capabilityId, input.leaseToken],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) invalidResponse();
    return mapGrant(requireRecord(result.rows[0]));
  }

  public async beginAuthenticated(
    input: Parameters<TenantDataBrokerAttemptStore['beginAuthenticated']>[0],
  ): ReturnType<TenantDataBrokerAttemptStore['beginAuthenticated']> {
    requireUuid(input.nonce);
    requireDate(input.signedAt);
    requireDate(input.expiresAt);
    requireUuid(input.capabilityId);
    requireUuid(input.leaseToken);
    requireOperation(input.operation);
    requireSha256(input.resourceReferenceSha256);
    const result = await this.database.query(
      `SELECT *
         FROM begin_authenticated_tenant_data_broker_effect(
           $1, $2, $3, $4, $5, $6, $7
         )`,
      [
        input.nonce,
        input.signedAt,
        input.expiresAt,
        input.capabilityId,
        input.leaseToken,
        input.operation,
        input.resourceReferenceSha256,
      ],
    );
    if (result.rows.length === 0) return { outcome: 'DENIED' };
    if (result.rows.length !== 1) invalidResponse();
    const row = requireExactRecord(result.rows[0], ['attempt_id', 'outcome', 'success_receipt']);
    switch (row.outcome) {
      case 'STARTED':
        if (
          typeof row.attempt_id !== 'string' ||
          !UUID.test(row.attempt_id) ||
          row.success_receipt !== null
        ) {
          invalidResponse();
        }
        return { outcome: 'STARTED', attemptId: row.attempt_id };
      case 'ALREADY_SUCCEEDED':
        if (row.attempt_id !== null || !isReceipt(row.success_receipt)) {
          invalidResponse();
        }
        return {
          outcome: 'ALREADY_SUCCEEDED',
          successReceipt: row.success_receipt,
        };
      case 'AMBIGUOUS':
        if (row.attempt_id !== null || row.success_receipt !== null) {
          invalidResponse();
        }
        return { outcome: 'AMBIGUOUS' };
      default:
        return invalidResponse();
    }
  }

  public async complete(
    input: Parameters<TenantDataBrokerAttemptStore['complete']>[0],
  ): Promise<void> {
    await this.finish(input.attemptId, input.leaseToken, 'SUCCESS', input.receipt);
  }

  public async fail(input: Parameters<TenantDataBrokerAttemptStore['fail']>[0]): Promise<void> {
    await this.finish(input.attemptId, input.leaseToken, input.outcome, null);
  }

  public async resolveObjectPut(
    input: Parameters<TenantDataBrokerEffectResolver['resolveObjectPut']>[0],
  ): Promise<TenantDataBrokerEffectResolution> {
    requireUuid(input.probeAttemptId);
    requireUuid(input.leaseToken);
    if (
      input.observation !== 'FOUND' &&
      input.observation !== 'MISSING' &&
      input.observation !== 'MISMATCH'
    ) {
      throw new Error('TENANT_DATA_BROKER_EFFECT_OBSERVATION_INVALID');
    }
    requireNullableBoundedString(input.observedVersionId, 1_024);
    requireNullableSha256(input.observedChecksum);
    requireNullableBoundedString(input.observedContentType, 512);
    if (
      input.observedByteLength !== null &&
      (!Number.isSafeInteger(input.observedByteLength) ||
        input.observedByteLength < 0 ||
        input.observedByteLength > MAX_OBJECT_BYTES)
    ) {
      throw new Error('TENANT_DATA_BROKER_EFFECT_OBSERVATION_INVALID');
    }
    const result = await this.database.query(
      `SELECT resolve_tenant_data_broker_object_put_effect(
         $1, $2, $3, $4, $5, $6, $7
       ) AS resolution`,
      [
        input.probeAttemptId,
        input.leaseToken,
        input.observation,
        input.observedVersionId,
        input.observedChecksum,
        input.observedContentType,
        input.observedByteLength,
      ],
    );
    return readResolution(result.rows);
  }

  public async resolveLegalHold(
    input: Parameters<TenantDataBrokerEffectResolver['resolveLegalHold']>[0],
  ): Promise<TenantDataBrokerEffectResolution> {
    requireUuid(input.probeAttemptId);
    requireUuid(input.leaseToken);
    if (input.observedStatus !== 'ON' && input.observedStatus !== 'OFF') {
      throw new Error('TENANT_DATA_BROKER_EFFECT_OBSERVATION_INVALID');
    }
    const result = await this.database.query(
      `SELECT resolve_tenant_data_broker_legal_hold_effect(
         $1, $2, $3
       ) AS resolution`,
      [input.probeAttemptId, input.leaseToken, input.observedStatus],
    );
    return readResolution(result.rows);
  }

  public async resolveSecretDelete(
    input: Parameters<TenantDataBrokerEffectResolver['resolveSecretDelete']>[0],
  ): Promise<TenantDataBrokerEffectResolution> {
    requireUuid(input.probeAttemptId);
    requireUuid(input.leaseToken);
    if (
      input.observation !== 'ABSENT' &&
      input.observation !== 'DELETION_REQUESTED' &&
      input.observation !== 'EXISTS'
    ) {
      throw new Error('TENANT_DATA_BROKER_EFFECT_OBSERVATION_INVALID');
    }
    const result = await this.database.query(
      `SELECT resolve_tenant_data_broker_secret_delete_effect(
         $1, $2, $3
       ) AS resolution`,
      [input.probeAttemptId, input.leaseToken, input.observation],
    );
    return readResolution(result.rows);
  }

  private async finish(
    attemptId: string,
    leaseToken: string,
    outcome: 'FAILED' | 'SUCCESS' | 'UNKNOWN',
    receipt: Readonly<Record<string, unknown>> | null,
  ): Promise<void> {
    requireUuid(attemptId);
    requireUuid(leaseToken);
    if (!isReceipt(receipt)) {
      throw new Error('TENANT_DATA_BROKER_RECEIPT_INVALID');
    }
    const result = await this.database.query(
      `SELECT finish_tenant_data_broker_effect(
         $1, $2, $3, $4::jsonb
       ) AS finished`,
      [attemptId, leaseToken, outcome, receipt],
    );
    if (
      result.rows.length !== 1 ||
      requireExactRecord(result.rows[0], ['finished']).finished !== true
    ) {
      throw new Error('TENANT_DATA_BROKER_ATTEMPT_NOT_FINISHED');
    }
  }
}

export class PostgresTenantDataCapabilityIssuer {
  public constructor(private readonly database: TenantDataBrokerSqlClient) {}

  public async issueAuthenticatedObjectRead(input: {
    sessionToken: string;
    membershipId: string;
    tenantId: string;
    workspaceId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.sessionToken)) invalidInput();
    for (const value of [
      input.membershipId,
      input.tenantId,
      input.workspaceId,
      input.leaseToken,
      input.capabilityId,
    ]) {
      requireUuid(value);
    }
    requireObjectCoordinate(input.objectKey);
    requireObjectCoordinate(input.objectVersionId);
    return this.issue(
      `SELECT issue_authenticated_object_read_capability(
         $1, $2, $3, $4, $5, $6, $7, $8
       ) AS capability_id`,
      [
        input.sessionToken,
        input.membershipId,
        input.tenantId,
        input.workspaceId,
        input.objectKey,
        input.objectVersionId,
        input.leaseToken,
        input.capabilityId,
      ],
    );
  }

  public async issueWorkloadObjectPut(input: WorkIntentIssueInput): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_workload_object_put_capability',
      input.operationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issuePublicationPackageRead(input: PublicationIssueInput): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_publication_package_read_capability',
      input.publicationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issuePublicationSecretRead(input: PublicationIssueInput): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_publication_secret_read_capability',
      input.publicationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueChannelAuthorizationValidationSecretRead(
    input: ChannelAuthorizationValidationIssueInput,
  ): Promise<string | null> {
    for (const value of [
      input.commandId,
      input.authorizationId,
      input.leaseToken,
      input.capabilityId,
    ]) {
      requireUuid(value);
    }
    return this.issue(
      `SELECT issue_channel_authorization_validation_secret_read_capability(
         $1, $2, $3, $4
       ) AS capability_id`,
      [input.commandId, input.authorizationId, input.leaseToken, input.capabilityId],
    );
  }

  public async issuePrivacyObjectPut(input: WorkIntentIssueInput): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_privacy_object_put_capability',
      input.operationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueWorkloadObjectRecoveryHead(
    input: WorkIntentIssueInput,
  ): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_workload_object_recovery_head_capability',
      input.operationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issuePrivacyObjectRecoveryHead(input: WorkIntentIssueInput): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_privacy_object_recovery_head_capability',
      input.operationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueConnectorSecretDescribe(
    input: ConnectorDeletionIssueInput,
  ): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_connector_secret_describe_capability',
      input.channelAuthorizationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueConnectorSecretDelete(
    input: ConnectorDeletionIssueInput,
  ): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_connector_secret_delete_capability',
      input.channelAuthorizationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueConnectorSecretVerifyUnreadable(
    input: ConnectorDeletionIssueInput,
  ): Promise<string | null> {
    return this.issueThreeUuid(
      'issue_connector_secret_verify_unreadable_capability',
      input.channelAuthorizationId,
      input.leaseToken,
      input.capabilityId,
    );
  }

  public async issueDeletionInventory(input: DeletionIssueInput): Promise<string | null> {
    return this.issueFour(
      `SELECT issue_deletion_inventory_capability(
         $1, $2, $3, $4
       ) AS capability_id`,
      [input.requestId, input.leaseToken, input.capabilityId],
      1000,
    );
  }

  public async issueDeletionObjectHead(input: DeletionObjectIssueInput): Promise<string | null> {
    return this.issueDeletionObject('issue_deletion_object_head_capability', input);
  }

  public async issueDeletionObjectGetLegalHold(
    input: DeletionObjectIssueInput,
  ): Promise<string | null> {
    return this.issueDeletionObject('issue_deletion_object_get_legal_hold_capability', input);
  }

  public async issueDeletionObjectDelete(input: DeletionObjectIssueInput): Promise<string | null> {
    return this.issueDeletionObject('issue_deletion_object_delete_capability', input);
  }

  public async issueLegalHoldSet(input: LegalHoldIssueInput): Promise<string | null> {
    return this.issueLegalHold('issue_legal_hold_set_capability', input);
  }

  public async issueLegalHoldGetRecovery(input: LegalHoldIssueInput): Promise<string | null> {
    return this.issueLegalHold('issue_legal_hold_get_recovery_capability', input);
  }

  private issueThreeUuid(
    functionName: ThreeUuidIssuerFunction,
    sourceId: string,
    leaseToken: string,
    capabilityId: string,
  ): Promise<string | null> {
    for (const value of [sourceId, leaseToken, capabilityId]) requireUuid(value);
    return this.issue(`SELECT ${functionName}($1, $2, $3) AS capability_id`, [
      sourceId,
      leaseToken,
      capabilityId,
    ]);
  }

  private issueDeletionObject(
    functionName: DeletionObjectIssuerFunction,
    input: DeletionObjectIssueInput,
  ): Promise<string | null> {
    for (const value of [input.requestId, input.leaseToken, input.capabilityId]) {
      requireUuid(value);
    }
    requireObjectCoordinate(input.objectKey);
    requireObjectCoordinate(input.objectVersionId);
    return this.issue(
      `SELECT ${functionName}(
         $1, $2, $3, $4, $5
       ) AS capability_id`,
      [
        input.requestId,
        input.leaseToken,
        input.capabilityId,
        input.objectKey,
        input.objectVersionId,
      ],
    );
  }

  private issueLegalHold(
    functionName: LegalHoldIssuerFunction,
    input: LegalHoldIssueInput,
  ): Promise<string | null> {
    for (const value of [input.tenantId, input.leaseToken, input.capabilityId]) {
      requireUuid(value);
    }
    requireObjectCoordinate(input.objectKey);
    requireObjectCoordinate(input.objectVersionId);
    return this.issue(
      `SELECT ${functionName}(
         $1, $2, $3, $4, $5
       ) AS capability_id`,
      [
        input.tenantId,
        input.objectKey,
        input.objectVersionId,
        input.leaseToken,
        input.capabilityId,
      ],
    );
  }

  private issueFour(
    statement: string,
    uuidValues: readonly [string, string, string],
    fixedValue: number,
  ): Promise<string | null> {
    for (const value of uuidValues) requireUuid(value);
    return this.issue(statement, [...uuidValues, fixedValue]);
  }

  private async issue(statement: string, values: readonly unknown[]): Promise<string | null> {
    const result = await this.database.query(statement, values);
    if (result.rows.length !== 1) invalidResponse();
    const capabilityId = requireExactRecord(result.rows[0], ['capability_id']).capability_id;
    if (capabilityId === null) return null;
    if (typeof capabilityId !== 'string' || !UUID.test(capabilityId)) {
      return invalidResponse();
    }
    return capabilityId;
  }
}

export interface WorkIntentIssueInput {
  operationId: string;
  leaseToken: string;
  capabilityId: string;
}

export interface PublicationIssueInput {
  publicationId: string;
  leaseToken: string;
  capabilityId: string;
}

export interface ChannelAuthorizationValidationIssueInput {
  commandId: string;
  authorizationId: string;
  leaseToken: string;
  capabilityId: string;
}

export interface ConnectorDeletionIssueInput {
  channelAuthorizationId: string;
  leaseToken: string;
  capabilityId: string;
}

export interface DeletionIssueInput {
  requestId: string;
  leaseToken: string;
  capabilityId: string;
}

export interface DeletionObjectIssueInput extends DeletionIssueInput {
  objectKey: string;
  objectVersionId: string;
}

export interface LegalHoldIssueInput {
  tenantId: string;
  objectKey: string;
  objectVersionId: string;
  leaseToken: string;
  capabilityId: string;
}

type ThreeUuidIssuerFunction =
  | 'issue_workload_object_put_capability'
  | 'issue_publication_package_read_capability'
  | 'issue_publication_secret_read_capability'
  | 'issue_privacy_object_put_capability'
  | 'issue_workload_object_recovery_head_capability'
  | 'issue_privacy_object_recovery_head_capability'
  | 'issue_connector_secret_describe_capability'
  | 'issue_connector_secret_delete_capability'
  | 'issue_connector_secret_verify_unreadable_capability';

type DeletionObjectIssuerFunction =
  | 'issue_deletion_object_head_capability'
  | 'issue_deletion_object_get_legal_hold_capability'
  | 'issue_deletion_object_delete_capability';

type LegalHoldIssuerFunction =
  'issue_legal_hold_set_capability' | 'issue_legal_hold_get_recovery_capability';

function mapGrant(row: DatabaseRecord): TenantDataAccessGrant {
  requireExactKeys(row, [
    'authority_kind',
    'authority_reference',
    'capability_id',
    'effect_identity',
    'expires_at',
    'lease_token_sha256',
    'operation',
    'resource',
    'resource_hash',
    'scope_kind',
    'tenant_id',
    'workspace_id',
  ]);
  if (
    typeof row.capability_id !== 'string' ||
    !UUID.test(row.capability_id) ||
    typeof row.lease_token_sha256 !== 'string' ||
    !SHA256.test(row.lease_token_sha256) ||
    typeof row.authority_kind !== 'string' ||
    row.authority_kind.length < 1 ||
    typeof row.authority_reference !== 'string' ||
    row.authority_reference.length < 1 ||
    (row.scope_kind !== 'TENANT' && row.scope_kind !== 'WORKSPACE') ||
    typeof row.tenant_id !== 'string' ||
    !UUID.test(row.tenant_id) ||
    (row.workspace_id !== null &&
      (typeof row.workspace_id !== 'string' || !UUID.test(row.workspace_id))) ||
    (row.scope_kind === 'WORKSPACE' && row.workspace_id === null) ||
    (row.scope_kind === 'TENANT' && row.workspace_id !== null) ||
    typeof row.operation !== 'string' ||
    !TENANT_DATA_OPERATIONS.has(row.operation as TenantDataOperation) ||
    !isPlainRecord(row.resource) ||
    typeof row.resource_hash !== 'string' ||
    !SHA256.test(row.resource_hash) ||
    typeof row.effect_identity !== 'string' ||
    row.effect_identity.length < 1 ||
    !(row.expires_at instanceof Date) ||
    !Number.isFinite(row.expires_at.getTime())
  ) {
    return invalidResponse();
  }
  return {
    capabilityId: row.capability_id,
    leaseTokenSha256: row.lease_token_sha256,
    authorityKind: row.authority_kind as TenantDataAccessGrant['authorityKind'],
    authorityReference: row.authority_reference,
    scopeKind: row.scope_kind,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    operation: row.operation as TenantDataOperation,
    resource: row.resource,
    expiresAt: row.expires_at.toISOString(),
  } as TenantDataAccessGrant;
}

function readResolution(rows: readonly unknown[]): TenantDataBrokerEffectResolution {
  if (rows.length !== 1) return invalidResponse();
  const resolution = requireExactRecord(rows[0], ['resolution']).resolution;
  if (
    resolution !== 'RESOLVED_SUCCESS' &&
    resolution !== 'RESOLVED_FAILED' &&
    resolution !== 'NOT_RESOLVED'
  ) {
    return invalidResponse();
  }
  return resolution;
}

function requireRecord(value: unknown): DatabaseRecord {
  if (!isPlainRecord(value)) return invalidResponse();
  return value;
}

function requireExactRecord(value: unknown, keys: readonly string[]): DatabaseRecord {
  const row = requireRecord(value);
  requireExactKeys(row, keys);
  return row;
}

function requireExactKeys(value: DatabaseRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidResponse();
  }
}

function isPlainRecord(value: unknown): value is DatabaseRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isReceipt(value: unknown): value is Readonly<Record<string, unknown>> | null {
  return value === null || isPlainRecord(value);
}

function requireUuid(value: string): void {
  if (!UUID.test(value)) throw new Error('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
}

function requireSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
}

function requireNullableSha256(value: string | null): void {
  if (value !== null) requireSha256(value);
}

function requireOperation(value: TenantDataOperation): void {
  if (!TENANT_DATA_OPERATIONS.has(value)) {
    throw new Error('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
  }
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
  }
}

function requireNullableBoundedString(value: string | null, maximumBytes: number): void {
  if (value !== null && (value.length < 1 || Buffer.byteLength(value, 'utf8') > maximumBytes)) {
    throw new Error('TENANT_DATA_BROKER_EFFECT_OBSERVATION_INVALID');
  }
}

function requireObjectCoordinate(value: string): void {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value.length < 1 || Buffer.byteLength(value, 'utf8') > 1_024 || hasControlCharacter) {
    invalidInput();
  }
}

function invalidInput(): never {
  throw new Error('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
}

function invalidResponse(): never {
  throw new Error('TENANT_DATA_BROKER_DATABASE_RESPONSE_INVALID');
}
