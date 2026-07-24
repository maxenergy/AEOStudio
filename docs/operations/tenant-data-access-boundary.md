# Tenant Data Access Boundary

## Current enforcement

The shared API and Worker ECS task roles are not tenant data-plane principals.
Both roles carry explicit `Deny` statements for:

- tenant connector-secret read, describe, and delete operations;
- artifact and audit-bucket object reads, writes, version inventory, legal-hold,
  retention, and deletion operations; and
- decrypt, encrypt, and data-key operations on the tenant data and secrets KMS
  keys.

The shared roles also have no `sts:AssumeRole` or `sts:TagSession` permission.
Consequently, compromised shared runtime credentials cannot restore data access
by selecting arbitrary `TenantId` or `WorkspaceId` session tags. ECS execution
roles retain only the exact bootstrap/runtime secrets required for container
injection; they are separate from task-role credentials.

`TenantDataBrokerAuthorizer` defines the broker's public authorization contract.
It accepts a capability and lease token, but authority comes only from an
injected store that resolves an exact active database grant. The returned grant
must match a constant-time SHA-256 lease binding, the Tenant, Workspace,
operation, Adapter authorization or object intent reference, resource
reference, authority kind, and a maximum five-minute expiry. The lease binding
is stripped from the authorized command. Every mismatch, malformed value,
expired lease, missing grant, or authority error returns the same
`TENANT_DATA_ACCESS_DENIED` outcome. Audit metadata contains only a SHA-256 of
the resource reference; the lease token, secret value, and reusable AWS
credentials are never returned.

## Required broker runtime

Production tenant-data operations remain fail-closed until a separately
isolated broker runtime and principal are implemented and verified in staging.
That broker must:

1. resolve the exact active Job plus lease, workload write intent, deletion
   intent, or authenticated object-read capability from PostgreSQL;
2. derive the Tenant, Workspace, Adapter authorization/object intent, AWS
   resource, and allowed operation from that authoritative row rather than
   caller-provided tags or ARNs;
3. execute only that exact secret or object operation through its isolated
   principal, without returning reusable broad AWS credentials;
4. keep connector plaintext in memory only for the exact Adapter invocation and
   never log, persist, trace, or include it in queue messages or artifacts; and
5. fence expiry/replay before and after every remote effect and emit only
   reference hashes and opaque capability/job identifiers to audit telemetry.

The existing direct AWS SDK adapters cannot bypass this boundary: calls made
with the shared API or Worker task credentials are denied by IAM. This is an
intentional safe failure, not evidence that the broker is deployed.

## Evidence status

- Local IAM/static contract: `PASS`.
- Local broker authorization policy tests: `PASS`.
- Broker compute, network identity, authoritative PostgreSQL grant adapter, and
  end-to-end staging effects: `NOT_CHECKED` / not implemented.
- Production apply: not performed.
