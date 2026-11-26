const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
test('reviewer snapshot includes candidate source without host caches or changes to the owner index', async () => {
  const moduleURL = require('node:url').pathToFileURL(
    join(__dirname, '../scripts/reviewer-snapshot.mjs'),
  ).href;
  const snapshotSource = (source, target) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {snapshotSource} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(snapshotSource(process.argv[1],process.argv[2])));`,
          source,
          target,
        ],
        { encoding: 'utf8' },
      ),
    );
  const task = mkdtempSync(join(tmpdir(), 'lab-snapshot-test-')),
    source = join(task, 'source'),
    target = join(task, 'archive');
  mkdirSync(source);
  mkdirSync(target);
  const git = (...args) =>
    execFileSync('git', args, { cwd: source, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '--quiet');
    writeFileSync(join(source, '.gitignore'), '.env*\nnode_modules/\n');
    writeFileSync(join(source, 'source.txt'), 'committed\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fictional fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    writeFileSync(join(source, 'source.txt'), 'staged\n');
    git('add', 'source.txt');
    writeFileSync(join(source, 'source.txt'), 'candidate\n');
    writeFileSync(join(source, 'new.txt'), 'new source\n');
    writeFileSync(join(source, '.env.private'), 'FAKE_SECRET');
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, 'node_modules', 'cache.txt'), 'host cache');
    const before = git('diff', '--cached', '--binary');
    const result = snapshotSource(source, target);
    expect(result.baseRevision).toBe(
      git('rev-parse', 'HEAD').toString().trim(),
    );
    expect(result.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(result.workingTreeDirty).toBe(true);
    expect(readFileSync(join(target, 'source.txt'), 'utf8')).toBe(
      'candidate\n',
    );
    expect(readFileSync(join(target, 'new.txt'), 'utf8')).toBe('new source\n');
    expect(existsSync(join(target, '.env.private'))).toBe(false);
    expect(existsSync(join(target, 'node_modules'))).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(false);
    expect(git('diff', '--cached', '--binary')).toEqual(before);
  } finally {
    rmSync(task, { recursive: true, force: true });
  }
});
