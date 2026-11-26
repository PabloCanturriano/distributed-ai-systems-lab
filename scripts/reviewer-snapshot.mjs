import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
export function snapshotSource(root, target) {
  root = resolve(root);
  target = resolve(target);
  if (readdirSync(target).length) throw Error('Snapshot target must be empty');
  const temporary = mkdtempSync(join(tmpdir(), 'lab-source-index-'));
  const git = (args, env = process.env) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    const baseRevision = git(['rev-parse', 'HEAD']).toString().trim();
    const objects = resolve(
      root,
      git(['rev-parse', '--git-path', 'objects']).toString().trim(),
    );
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(temporary, 'index'),
      GIT_OBJECT_DIRECTORY: join(temporary, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
    };
    mkdirSync(env.GIT_OBJECT_DIRECTORY);
    git(['read-tree', 'HEAD'], env);
    git(['add', '--all'], env);
    const tree = git(['write-tree'], env).toString().trim();
    const archive = join(temporary, 'source.tar');
    git(['archive', '--format=tar', '--output=' + archive, tree], env);
    execFileSync('tar', ['-xf', archive, '-C', target], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      baseRevision,
      tree,
      workingTreeDirty:
        git(['status', '--porcelain']).toString().trim().length > 0,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function implementationDigest(root) {
  const names = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter((name) =>
      /^(apps\/|packages\/|database\/|fixtures\/|scripts\/|tests\/|infra\/|\.github\/|package(?:-lock)?\.json$|.*config.*\.(?:json|cjs)$|compose\.yaml$|\.dockerignore$|\.gitignore$|\.prettierignore$|docs\/quality\/phase[23456]-acceptance\.json$)/.test(
        name,
      ),
    );
  const hash = createHash('sha256');
  for (const name of [...new Set(names)].sort())
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(root, name)))
      .update('\0');
  return hash.digest('hex');
}
