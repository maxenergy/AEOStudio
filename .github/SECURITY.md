# Security response policy

Do not open a public issue for a suspected vulnerability. Report it through the repository's private security-advisory channel and include the affected exact version or image digest, reproduction conditions, and potential Tenant impact.

The accountable security owner must classify each confirmed finding and record one of these outcomes:

- Critical: remediate or approve a named, scoped, compensating, expiring exception within 24 hours.
- High: remediate or approve the same kind of exception within 7 calendar days.
- Lower severity: schedule a reviewed fix through the weekly dependency-maintenance queue.

An exception is not approval by omission. Production promotion remains blocked unless the protected environment supplies an external `AEO_LICENSE_APPROVAL_REFERENCE` and binds `AEO_APPROVED_SUPPLY_CHAIN_POLICY_SHA256` to the SHA-256 of a stable two-line manifest: first the SHA-256 and path for `scripts/security/container-base-policy.json`, then the SHA-256 and path for `scripts/security/license-policy.json`, using standard `sha256sum` two-space separators and LF endings. Expired exceptions block again automatically.
