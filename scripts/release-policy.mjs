export const releaseRoles = [
  'api',
  'worker',
  'relay',
  'consumer',
  'executor',
  'cli',
  'operations',
  'database',
];

export function releasePlan(version, revision) {
  if (!/^v0\.\d+\.\d+-rc\.[1-9]\d*$/.test(version ?? '') || version.length > 64)
    throw Error('An explicit v0.x.y-rc.N version is required');
  if (!/^[a-f0-9]{40}$/.test(revision ?? ''))
    throw Error('An immutable Git revision is required');
  return {
    schemaVersion: 1,
    version,
    revision,
    registry: 'ghcr.io/pablocanturriano/distributed-ai-systems-lab',
    roles: releaseRoles,
  };
}

export function assessReleaseImage(report, notices, image, architecture) {
  const issues = [];
  if (report.Metadata?.ImageID !== image || notices.image !== image)
    issues.push('image_identity_mismatch');
  if (report.Metadata?.ImageConfig?.architecture !== architecture)
    issues.push('architecture_mismatch');
  if (!Array.isArray(report.Results) || !report.Results.length)
    issues.push('missing_scan_results');
  for (const result of report.Results ?? [])
    for (const finding of result.Vulnerabilities ?? [])
      if (['HIGH', 'CRITICAL'].includes(finding.Severity))
        issues.push('unresolved_high_or_critical');
  if (
    !Array.isArray(notices.packages) ||
    !notices.packages.length ||
    !Array.isArray(notices.files) ||
    !notices.files.length
  )
    issues.push('missing_notice_inventory');
  if (
    (notices.skippedLinks ?? []).length ||
    (notices.packages ?? []).some(
      (pkg) => pkg.missingLicenseText || !pkg.declaredLicense,
    )
  )
    issues.push('incomplete_notices');
  return [...new Set(issues)];
}

export function releaseImageOverrides(manifest, revision) {
  const plan = releasePlan(manifest.version, manifest.revision);
  if (
    manifest.schemaVersion !== 1 ||
    plan.revision !== revision ||
    !Array.isArray(manifest.images) ||
    JSON.stringify(manifest.images.map((x) => x.role).sort()) !==
      JSON.stringify([...releaseRoles].sort())
  )
    throw Error('Published image manifest does not match source and roles');
  const services = {};
  for (const item of manifest.images) {
    const prefix = `${plan.registry}/${item.role}@sha256:`;
    if (
      !item.ref?.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(item.ref.slice(prefix.length)) ||
      JSON.stringify([...item.architectures].sort()) !==
        JSON.stringify(['amd64', 'arm64'])
    )
      throw Error('Immutable multi-platform project images are required');
    for (const service of item.role === 'database'
      ? ['secrets', 'bootstrap', 'migrate', 'seed']
      : [item.role])
      services[service] = { image: item.ref };
  }
  return { services };
}
