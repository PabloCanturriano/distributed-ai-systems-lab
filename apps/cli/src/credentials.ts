import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Credential } from './cli';

// The read-only volume is provisioned by the trusted seed process. No path or
// endpoint can be selected by command arguments or a server response.
export async function readCredential(alias: string): Promise<Credential> {
  const directory = '/run/lab/demo/identities';
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Invalid credentials');
  const file = await open(
    `${directory}/identities-v1.json`,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 16384
    )
      throw new Error('Invalid credentials');
    const manifest = JSON.parse(await file.readFile('utf8')) as {
      version?: unknown;
      fixtureDigest?: unknown;
      credentials?: unknown;
    };
    if (
      manifest.version !== 'identities-v1' ||
      typeof manifest.fixtureDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.fixtureDigest) ||
      !Array.isArray(manifest.credentials) ||
      manifest.credentials.length !== 6
    )
      throw new Error('Invalid credentials');
    const names = new Set<string>(),
      ids = new Set<string>();
    let selected: Credential | undefined;
    for (const entry of manifest.credentials) {
      if (!entry || typeof entry !== 'object')
        throw new Error('Invalid credentials');
      const {
        alias: name,
        lookupId,
        secret,
      } = entry as Record<string, unknown>;
      if (
        typeof name !== 'string' ||
        !/^(harbor|summit)\.(reader|requester|operator)$/.test(name) ||
        typeof lookupId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          lookupId,
        ) ||
        typeof secret !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        Buffer.from(secret, 'base64url').toString('base64url') !== secret ||
        names.has(name) ||
        ids.has(lookupId)
      )
        throw new Error('Invalid credentials');
      names.add(name);
      ids.add(lookupId);
      if (name === alias) selected = { lookupId, secret };
    }
    if (!selected) throw new Error('Invalid credentials');
    return selected;
  } finally {
    await file.close();
  }
}
