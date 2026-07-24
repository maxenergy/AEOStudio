function fail(code) {
  throw new Error(code);
}

const FROZEN_AUTOMATIC_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
]);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
  );
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function exactVersionedPurl(value) {
  return (
    typeof value === 'string' &&
    /^pkg:[a-z0-9.+-]+\/[^*?\s]+@[^*?\s]+(?:\?[^*\s#]+)?(?:#[^*\s]+)?$/u.test(value)
  );
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function licenseExceptionKey(purl, license) {
  return `${purl}\u0000${license}`;
}

export function validateLicensePolicy(policy, today = new Date().toISOString().slice(0, 10)) {
  if (
    !isIsoDate(today) ||
    !exactKeys(policy, ['schemaVersion', 'allowlist', 'exceptions']) ||
    policy?.schemaVersion !== 'aeostudio.cyclonedx-license-policy.v1' ||
    !exactKeys(policy?.allowlist, ['name', 'licenses']) ||
    !nonBlank(policy.allowlist.name) ||
    !Array.isArray(policy.allowlist.licenses) ||
    !Array.isArray(policy.exceptions)
  ) {
    fail('LICENSE_POLICY_INVALID');
  }
  const allowedLicenses = new Set(policy.allowlist.licenses);
  if (
    allowedLicenses.size !== policy.allowlist.licenses.length ||
    allowedLicenses.size !== FROZEN_AUTOMATIC_LICENSES.size ||
    policy.allowlist.licenses.some(
      (license) =>
        !nonBlank(license) || license.includes('*') || !FROZEN_AUTOMATIC_LICENSES.has(license),
    )
  ) {
    fail('LICENSE_POLICY_INVALID');
  }

  const exceptionByScopeAndLicense = new Map();
  const exceptionNames = new Set();
  for (const exception of policy.exceptions) {
    const purl = exception?.scope?.purl;
    if (
      !exactKeys(exception, [
        'name',
        'scope',
        'license',
        'reason',
        'compensatingControl',
        'owner',
        'expiresAt',
      ]) ||
      !exactKeys(exception?.scope, ['purl']) ||
      !nonBlank(exception.name) ||
      !exactVersionedPurl(purl) ||
      !nonBlank(exception.license) ||
      exception.license.includes('*') ||
      !nonBlank(exception.reason) ||
      !nonBlank(exception.compensatingControl) ||
      !nonBlank(exception.owner) ||
      !isIsoDate(exception.expiresAt) ||
      exceptionNames.has(exception.name)
    ) {
      fail('LICENSE_POLICY_INVALID');
    }
    exceptionNames.add(exception.name);
    if (exception.expiresAt < today) {
      fail(`LICENSE_EXCEPTION_EXPIRED:${exception.name}:${exception.expiresAt}`);
    }
    const key = licenseExceptionKey(purl, exception.license);
    if (exceptionByScopeAndLicense.has(key)) fail('LICENSE_POLICY_INVALID');
    exceptionByScopeAndLicense.set(key, exception);
  }
  return { allowedLicenses, exceptionByScopeAndLicense };
}

export function npmPackagePurl(name, version) {
  if (!nonBlank(name) || !nonBlank(version)) fail('LICENSE_REPORT_INVALID');
  if (name.startsWith('@')) {
    const separator = name.indexOf('/');
    if (separator <= 1 || separator === name.length - 1) fail('LICENSE_REPORT_INVALID');
    return `pkg:npm/%40${encodeURIComponent(name.slice(1, separator))}/${encodeURIComponent(
      name.slice(separator + 1),
    )}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}
