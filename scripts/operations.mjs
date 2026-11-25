import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  readSync,
  writeFileSync,
  realpathSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from 'node:fs';
const exec = promisify(execFile);
const fail = (code) => {
  throw Object.assign(new Error('Operational command rejected.'), {
    safeCode: code,
  });
};
function parse(args) {
  const command = args.shift(),
    options = {};
  if (!['inspect', 'plan', 'repair'].includes(command))
    fail('INVALID_ARGUMENTS');
  while (args.length) {
    const name = args.shift(),
      value = args.shift();
    if (
      !['--project', '--input', '--output', '--plan', '--confirm'].includes(
        name,
      ) ||
      !value ||
      value.startsWith('--') ||
      name in options
    )
      fail('INVALID_ARGUMENTS');
    options[name] = value;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options['--project'] ?? ''))
    fail('INVALID_ARGUMENTS');
  if (
    (command === 'inspect' && Object.keys(options).length !== 1) ||
    (command === 'plan' &&
      (!options['--input'] ||
        !options['--output'] ||
        Object.keys(options).length !== 3)) ||
    (command === 'repair' &&
      (!options['--plan'] ||
        !options['--confirm'] ||
        Object.keys(options).length !== 3))
  )
    fail('INVALID_ARGUMENTS');
  return { command, options };
}
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.size > 8192 ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0
    )
      fail('INVALID_PLAN');
    const bytes = Buffer.alloc(8193);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 8192) fail('INVALID_PLAN');
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
const digest = (plan) =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex');
async function run() {
  const { command, options } = parse(process.argv.slice(2)),
    project = options['--project'],
    directory = realpathSync(process.cwd());
  let plan;
  if (command === 'repair') {
    plan = readPrivate(options['--plan']);
    if (
      plan.schemaVersion !== 1 ||
      plan.project !== project ||
      plan.directory !== directory ||
      !plan.input ||
      typeof plan.input !== 'object' ||
      digest(plan) !== options['--confirm']
    )
      fail('PLAN_CONFLICT');
  }
  const prefix = [
    'compose',
    '--project-name',
    project,
    '--file',
    'compose.yaml',
  ];
  const docker = async (args, input) => {
    const p = exec('docker', args, { timeout: 40000, maxBuffer: 1024 * 1024 });
    p.child.stdin.end(input);
    return p;
  };
  // Inspect a running existing database first. Never create resources for a typo.
  const id = (
    await docker([...prefix, 'ps', '--quiet', 'postgres'])
  ).stdout.trim();
  if (!id) fail('PROJECT_CONFLICT');
  const info = JSON.parse((await docker(['inspect', id])).stdout)[0],
    labels = info.Config.Labels;
  if (
    labels['com.docker.compose.project'] !== project ||
    realpathSync(labels['com.docker.compose.project.working_dir']) !==
      directory ||
    !info.State.Running
  )
    fail('PROJECT_CONFLICT');
  const actor = async (action, input) => {
    let r;
    try {
      r = await docker(
        [...prefix, 'run', '--rm', '--no-deps', '-T', 'operations', action],
        input ? JSON.stringify(input) : undefined,
      );
    } catch (error) {
      let code = 'DEPENDENCY_UNAVAILABLE';
      try {
        const value = JSON.parse(error.stdout);
        if (
          [
            'INVALID_REQUEST',
            'ENVIRONMENT_CONFLICT',
            'NOT_FOUND',
            'REPAIR_CONFLICT',
            'IDEMPOTENCY_CONFLICT',
            'DEPENDENCY_UNAVAILABLE',
          ].includes(value.error?.code)
        )
          code = value.error.code;
      } catch {}
      fail(code);
    }
    return JSON.parse(r.stdout);
  };
  if (command === 'inspect') {
    const r = await actor('inspect');
    console.log(JSON.stringify({ schemaVersion: 1, project, ...r.result }));
    return;
  }
  if (command === 'plan') {
    const input = readPrivate(options['--input']),
      r = await actor('plan', input);
    plan = { schemaVersion: 1, project, directory, input: r.result };
    writeFileSync(options['--output'], JSON.stringify(plan, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        project,
        environmentId: plan.input.environmentId,
        ticketId: plan.input.ticketId,
        generation: plan.input.generation,
        expectedEventId: plan.input.expectedEventId,
        source: plan.input.source,
        reason: plan.input.reason,
        key: plan.input.key,
        confirmDigest: digest(plan),
        outcome: 'plan_only',
      }),
    );
    return;
  }
  const r = await actor('repair', plan.input);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      project,
      outcome: 'repaired',
      receipt: r.result,
    }),
  );
}
void run().catch((error) => {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      outcome: 'error',
      error: {
        code: error.safeCode ?? 'DEPENDENCY_UNAVAILABLE',
        message: 'Operational command rejected or unavailable.',
      },
    }),
  );
  process.exitCode = [
    'INVALID_ARGUMENTS',
    'INVALID_PLAN',
    'PLAN_CONFLICT',
  ].includes(error.safeCode)
    ? 2
    : 3;
});
