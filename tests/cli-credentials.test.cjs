const fs = require('node:fs/promises');
const { readCredential } = require('../apps/cli/dist/credentials');
const aliases = [
  'harbor.reader',
  'harbor.requester',
  'harbor.operator',
  'summit.reader',
  'summit.requester',
  'summit.operator',
];
function fixture() {
  return {
    version: 'identities-v1',
    fixtureDigest: 'a'.repeat(64),
    credentials: aliases.map((alias, i) => ({
      alias,
      lookupId: `a3000000-0000-4000-8000-00000000000${i + 1}`,
      secret: Buffer.alloc(32, i + 1).toString('base64url'),
    })),
  };
}
function files(manifest = fixture(), mode = 0o600) {
  const close = jest.fn(async () => {});
  jest.spyOn(fs, 'lstat').mockResolvedValue({
    isDirectory: () => true,
    uid: process.getuid(),
    mode: 0o700,
  });
  const open = jest.spyOn(fs, 'open').mockResolvedValue({
    stat: async () => ({
      isFile: () => true,
      uid: process.getuid(),
      mode,
      size: 1000,
    }),
    readFile: async () => JSON.stringify(manifest),
    close,
  });
  return { close, open };
}
afterEach(() => jest.restoreAllMocks());
test('the private manifest selects exactly the requested identity and closes the file', async () => {
  const manifest = fixture(),
    { close } = files(manifest);
  expect(await readCredential('summit.requester')).toEqual({
    lookupId: manifest.credentials[4].lookupId,
    secret: manifest.credentials[4].secret,
  });
  expect(close).toHaveBeenCalledTimes(1);
});
test.each([0o644, 0o660, 0o400])(
  'credential files with unexpected mode %s fail closed',
  async (mode) => {
    const { close } = files(fixture(), mode);
    await expect(readCredential('harbor.reader')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(close).toHaveBeenCalledTimes(1);
  },
);
test.each([
  'duplicate alias',
  'duplicate lookup',
  'bad secret',
  'missing entry',
  'unknown version',
  'malformed digest',
])('invalid complete manifests are rejected: %s', async (kind) => {
  const manifest = fixture();
  if (kind === 'duplicate alias')
    manifest.credentials[5].alias = manifest.credentials[0].alias;
  if (kind === 'duplicate lookup')
    manifest.credentials[5].lookupId = manifest.credentials[0].lookupId;
  if (kind === 'bad secret') manifest.credentials[5].secret = 'invalid';
  if (kind === 'missing entry') manifest.credentials.pop();
  if (kind === 'unknown version') manifest.version = 'unknown';
  if (kind === 'malformed digest') manifest.fixtureDigest = 'bad';
  const { close } = files(manifest);
  await expect(readCredential('harbor.reader')).rejects.toThrow(
    'Invalid credentials',
  );
  expect(close).toHaveBeenCalledTimes(1);
});
test('symlinked or publicly readable identity directories are rejected before opening a credential', async () => {
  const { open } = files();
  fs.lstat.mockResolvedValue({
    isDirectory: () => false,
    uid: process.getuid(),
    mode: 0o700,
  });
  await expect(readCredential('harbor.reader')).rejects.toThrow(
    'Invalid credentials',
  );
  expect(open).not.toHaveBeenCalled();
  fs.lstat.mockResolvedValue({
    isDirectory: () => true,
    uid: process.getuid(),
    mode: 0o755,
  });
  await expect(readCredential('harbor.reader')).rejects.toThrow(
    'Invalid credentials',
  );
  expect(open).not.toHaveBeenCalled();
});
