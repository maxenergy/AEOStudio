# AEOStudio Signed Webhook Contract v1

Status: stable contract for `schemaVersion: "1.0.0"`  
JSON Schema: [`signed-webhook-v1.schema.json`](./signed-webhook-v1.schema.json)

This contract sends one exact, approved Channel Package to a verified self-hosted CMS endpoint. It
does not imply that the receiver published the package to a production website. The protocol has no
unsigned mode and does not permit arbitrary destination URLs.

The normative words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are interpreted as described by
RFC 2119 and RFC 8174.

## 1. Contract objects

The schema bundle exposes these fragments:

| Fragment | Purpose |
| --- | --- |
| `#/$defs/Target` | Stored, versioned delivery configuration |
| `#/$defs/Delivery` | Approved Channel Package delivery body |
| `#/$defs/ReceiptQuery` | Signed reconciliation request body |
| `#/$defs/Receipt` | Receiver delivery receipt |

All objects are strict: receivers MUST reject unknown properties. UUIDs and lowercase, 64-character
SHA-256 values are required where the schema says so. Cross-field rules that JSON Schema cannot
express portably are normative in this document.

### 1.1 Target

`Target` uses `schemaVersion: "signed-webhook-target.v1"` and contains:

- `endpointUrl`: delivery endpoint;
- `receiptUrl`: reconciliation endpoint;
- `endpointVerificationId`: identifier of the completed administrative endpoint verification;
- `algorithm`: `HMAC_SHA256` or `ED25519`;
- `keyId`: exact verification key selected for this target.

Both URLs MUST be canonical HTTPS URLs, have a lowercase host, use the default HTTPS port, contain
no username, password, query, or fragment, and share the same origin. They MUST exactly match the
administratively verified allowlist tuple. A boolean supplied by a customer such as `verified: true`
is never evidence of verification.

The platform encodes a target as
`signed-webhook:v1:<base64url-without-padding(JSON(Target))>`. A decoder MUST reject a non-canonical
encoding, an invalid or unknown field, or a target that does not reproduce the original encoded
value.

### 1.2 Delivery

The delivery body has:

- `schemaVersion: "1.0.0"`;
- `eventType: "channel-package.approved.v1"`;
- `deliveryId` and `publicationId`, which MUST be identical;
- the exact approved `channelPackage`, including tenant/workspace lineage, package ID/revision/hash,
  channel and transformer versions, Artifact revision/hash, manifest/evidence lineage, and the three
  approved files.

`deliveryId` is stable across attempts. For v1 it is the Publication ID. Timestamp, nonce, key
rotation, and retry count MUST NOT change the delivery body or its digest.

### 1.3 Receipt query and receipt

A reconciliation request is a signed POST of `ReceiptQuery` to `receiptUrl`. It repeats the exact
delivery lineage and `requestBodySha256`, the lowercase hexadecimal SHA-256 of the original canonical
delivery body bytes. Its `deliveryId` MUST equal its `publicationId`.

A `Receipt` MUST echo every lineage/hash field from the delivery or query. It also contains the
receiver's `receiptId`, status, effect identifier, receipt time, `remoteRef`, and the exact
`verifiedKeyId`/`verifiedAlgorithm` used to authenticate that request. For the v1 adapter,
`remoteRef` is the canonical receipt URL followed by `/` and the delivery ID, and
`isProductionLive` is always `false`.

The following invariant is mandatory:

| Receipt status | `receiverEffectId` | Meaning |
| --- | --- | --- |
| `APPLIED` | non-null | This delivery created one receiver effect |
| `ALREADY_APPLIED` | non-null | The same delivery/digest already created that effect |
| `PENDING` | null | Outcome is not yet known |
| `NOT_FOUND` | null | No matching effect is currently known |
| `CONFLICT` | null | The delivery ID exists with different immutable data |

Only a schema-valid receipt whose IDs, revisions, hashes, URL, verified key/algorithm, and effect
invariant all match the immutable target and request is evidence of application. A successful
receipt means **delivered to the receiver**, not published to a production website.

## 2. Canonical request body and digest

The sender MUST serialize each `Delivery` or `ReceiptQuery` as canonical JSON using the JSON
Canonicalization Scheme in [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html): UTF-8, no
insignificant whitespace, deterministic object-member ordering, and JSON number/string encoding.
Before serialization, both sides MUST reject non-finite numbers, non-JSON values, sparse/cyclic
structures, and strings or member names containing an unpaired UTF-16 surrogate.

The sender computes SHA-256 over those exact bytes and emits the
[RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html) header:

```http
content-digest: sha-256=:BASE64_OF_RAW_SHA256_BYTES:
```

The receiver MUST compute the digest from the received bytes before parsing or reserializing JSON
and compare it in constant time. `requestBodySha256` uses lowercase hexadecimal encoding of the same
delivery-body digest. The digest of a receipt-query HTTP request is computed over the query body;
the query's `requestBodySha256` field continues to identify the original delivery body.

## 3. HTTP Message Signature profile

Every delivery and receipt query MUST use this narrowed profile of
[RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html). Header names are sent in lowercase. HTTP
field names remain case-insensitive, but signature component identifiers and their order are fixed.

Required request fields:

```http
content-type: application/json; charset=utf-8
content-digest: sha-256=:BASE64_OF_RAW_SHA256_BYTES:
webhook-id: DELIVERY_ID
aeostudio-schema-version: 1.0.0
signature-input: aeo=("@method" "@target-uri" "content-type" "content-digest" "webhook-id" "aeostudio-schema-version");created=UNIX_SECONDS;expires=UNIX_SECONDS;nonce="NONCE";keyid="KEY_ID";alg="hmac-sha256|ed25519";tag="aeostudio-signed-webhook-v1"
signature: aeo=:BASE64_SIGNATURE_BYTES:
```

The signature label MUST be `aeo`. The covered components MUST be present exactly once in the shown
order. The parameters MUST appear in the shown order and have these semantics:

- `created`: integer UTC Unix seconds at signing time;
- `expires`: exactly `created + 300`; v1 has a fixed five-minute signature lifetime;
- `nonce`: new for every delivery or reconciliation request; production values SHOULD contain at
  least 128 bits of cryptographically secure randomness;
- `keyid`: exact target key ID;
- `alg`: `hmac-sha256` for target `HMAC_SHA256`, or `ed25519` for target `ED25519`;
- `tag`: exactly `aeostudio-signed-webhook-v1`.

The RFC 9421 signature base is therefore constructed as follows, with the final line containing the
exact serialized value after `aeo=` in `signature-input`:

```text
"@method": POST
"@target-uri": https://receiver.example/delivery-or-receipt-path
"content-type": application/json; charset=utf-8
"content-digest": sha-256=:BASE64_OF_RAW_SHA256_BYTES:
"webhook-id": DELIVERY_ID
"aeostudio-schema-version": 1.0.0
"@signature-params": ("@method" "@target-uri" "content-type" "content-digest" "webhook-id" "aeostudio-schema-version");created=UNIX_SECONDS;expires=UNIX_SECONDS;nonce="NONCE";keyid="KEY_ID";alg="hmac-sha256|ed25519";tag="aeostudio-signed-webhook-v1"
```

The receiver MUST reject a missing/duplicate component or parameter, another label/tag, a changed
order, an unsupported algorithm, a key/algorithm mismatch, a timestamp outside its configured
window, an expired signature, or any signature mismatch. It MUST verify the signature and timestamp
before applying an effect. A v1 receiver MAY tolerate at most 30 seconds of positive or negative
clock skew at the `created`/`expires` boundaries; this tolerance does not change the signed
five-minute lifetime.

For `HMAC_SHA256`, the signature is HMAC-SHA-256 over the UTF-8 signature base. An endpoint-specific
key of at least 32 bytes MUST be used; global platform keys MUST NOT be reused. For `ED25519`, the
signature is Ed25519 over the same bytes. There is no algorithm fallback or downgrade.

## 4. Replay protection and delivery idempotency

Nonce replay protection and delivery idempotency solve different problems and MUST be implemented
separately:

1. After signature and timestamp verification, the receiver atomically checks and stores the
   `(endpoint verification, keyid, nonce)` replay key until the request can no longer be accepted.
   Reuse rejects that request with no new effect (the fixture reports HTTP 409
   `REPLAY_REJECTED`).
2. After replay validation and schema/hash validation, the receiver atomically applies by stable
   `deliveryId` and original delivery digest.
3. A new signed request with a new nonce, the same delivery ID, and the same delivery digest returns
   `ALREADY_APPLIED` and the original effect ID. The effect count remains one.
4. The same delivery ID with a different digest or immutable lineage returns `CONFLICT`, creates no
   new effect, and requires manual review.

A sender MUST use a fresh timestamp, nonce, and signature for each attempt. It MUST NOT retry by
replaying captured headers. An ambiguous attempt is reconciled before any possible resend.

## 5. Key rotation

Signing material is stored only in the platform's secret store. It MUST NOT appear in a target,
request body, JSON Schema, URL, receipt, `remoteRef`, log, audit snapshot, or error message.

Each key record is bound to one `keyId`, one algorithm, `validFrom`, and optional `validUntil`. A new
delivery uses only the target's exact active, currently valid key. The receiver MAY retain an old
key during an explicit overlap window, but MUST reject it at `validUntil`. Rotation is performed by:

1. provisioning the new receiver verification key;
2. overlapping old and new validity windows;
3. changing the target's active key ID;
4. retiring and then deleting the old signing key after its acceptance and reconciliation windows.

An ambiguous delivery keeps its immutable target. During the overlap window, reconciliation is
therefore signed with that target's still-valid old key even if the key ring has advanced its active
key; a new publish MUST NOT silently inherit a different key from mutable secret contents. After
the overlap expires, unresolved deliveries require an explicitly authorized new target/manual
handling. Ed25519 receivers receive only the public key. HMAC keys are endpoint-specific shared
verification material and require equivalent protection on both sides.

## 6. Endpoint and SSRF requirements

Platform challenge verification is required before a target can be authorized:

1. An Owner or Admin registers the canonical delivery and receipt URLs. The platform creates a
   `PENDING` verification. If the URLs are byte-for-byte identical after canonical validation, the
   create response contains one `DELIVERY_AND_RECEIPT` proof. Otherwise it contains independent
   `DELIVERY` and `RECEIPT` proofs, each bound to its exact URL and a distinct cryptographically
   random challenge. Every challenge expires after 15 minutes. The create response MUST use
   `Cache-Control: private, no-store`; challenges are shown only in that response and are never
   returned by list, delivery, receipt, log, or audit APIs.
2. For every required proof, the platform sends an HTTPS POST to that proof's exact URL with exactly
   `{"schemaVersion":"aeostudio.signed-webhook-endpoint-challenge.v1",
   "verificationId":"...","purpose":"DELIVERY|RECEIPT|DELIVERY_AND_RECEIPT",
   "exactUrl":"...","challenge":"..."}`. The receiver MUST respond with HTTP 200,
   `content-type: application/json`, and exactly the same five JSON fields, using
   `schemaVersion: "aeostudio.signed-webhook-endpoint-challenge-response.v1"` and echoing the other
   four values exactly. Proof at another path on the same origin is not valid for the registered
   URL.
3. The platform performs the proof request with fresh DNS resolution, public-address validation,
   address pinning, TLS hostname verification, no redirects, a five-second timeout, and a 4 KiB
   response limit. Any mismatch, expiry, DNS rebinding, private address, redirect, transport error,
   extra response field, or malformed response leaves the verification `PENDING`.
4. All required proofs MUST succeed and remain unexpired before one atomic transition to
   `VERIFIED`. A failed receipt proof cannot be replaced by a successful delivery proof, including
   on a shared SaaS origin. Failure, expiry, replay, or a losing concurrent verification attempt
   leaves that attempt with no state or audit transition.
5. Only the durable `VERIFIED` tuple can authorize delivery or reconciliation. A `PENDING`
   verification causes publish and reconcile to return before DNS resolution or any provider HTTP
   request. Administrative attestation, a caller-supplied verification reference, or possession of
   an authenticated platform session is not endpoint-ownership proof.

The sender MUST apply all of these controls to the verification proof, delivery, and reconciliation
requests:

- exact match to the verified endpoint URL, receipt URL, verification ID, key ID, and algorithm;
- canonical HTTPS only; reject userinfo, query, fragment, non-default port, and cross-origin receipt
  endpoints;
- resolve DNS immediately before every request and reject the entire result if any address is not a
  public network address;
- pin the connection to a freshly resolved public address while preserving TLS hostname
  verification, and reject a connected address outside the fresh result set;
- never follow an HTTP redirect;
- enforce request timeout and response-size limits;
- repeat every check for reconciliation instead of trusting a previous resolution.

Private, loopback, link-local, metadata, multicast, reserved/documentation, IPv4-mapped private IPv6,
mixed public/private DNS, DNS rebinding, and connected-address mismatch are blocked. There is no
private-network fallback and no arbitrary blind POST.

## 7. Delivery response and reconciliation semantics

The adapter uses conservative outcome classification:

| Observation | Classification/action |
| --- | --- |
| HTTP 200/201 plus an exact `APPLIED` or `ALREADY_APPLIED` receipt | Applied; record the receipt URL and exact lineage/hash evidence |
| HTTP 202 or a matching `PENDING` receipt | Ambiguous; reconcile; never treat as applied |
| HTTP 204, empty/malformed 2xx, or any mismatched receipt | Ambiguous; reconcile/manual review |
| Timeout, connection reset after send, HTTP 408, or HTTP 5xx | Ambiguous; reconcile before retry |
| HTTP 3xx | Block redirect and classify as ambiguous; never follow it |
| Definitive DNS/TLS/connect failure before bytes are sent | Definitely not applied |
| Explicit signature/timestamp rejection with a no-effect response | Definitely not applied |
| HTTP 409 delivery conflict or `CONFLICT` receipt | Manual review; do not resend automatically |
| HTTP 429 | Retry only when the receiver explicitly guarantees no effect; otherwise reconcile |

For reconciliation, the adapter sends a newly signed `ReceiptQuery` to the verified `receiptUrl`.
An exact `APPLIED`/`ALREADY_APPLIED` receipt resolves the Publication as applied. `PENDING` or
`NOT_FOUND` remains unresolved and eventually requires manual review; `CONFLICT` requires immediate
manual review. A reconciliation timeout, 5xx, redirect, malformed body, or mismatched evidence also
remains ambiguous.

The sender persists a bounded, immutable receipt-evidence projection with the Publication record;
the receiver SHOULD retain the matching receipt metadata and exact delivery body hash. Neither side
stores signing material in the receipt evidence or logs request bodies. `DELIVERED` means the
receiver acknowledged one effect and `isProductionLive: false`; this contract does not assert CMS
publication state and defines no rollback operation.
