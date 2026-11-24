import { randomUUID } from 'node:crypto';
import { Command as Commander } from 'commander';

export interface Credential {
  lookupId: string;
  secret: string;
}
interface Dependencies {
  credential: (alias: string) => Promise<Credential>;
  fetch?: typeof fetch;
  key?: () => string;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  progress?: (status: 'queued' | 'processing') => void;
  signal?: AbortSignal;
}
interface Output {
  schemaVersion: 1;
  command: string;
  outcome: string;
  elapsedMs: number;
  identity?: string;
  key?: string;
  requestId?: string;
  ticket?: Record<string, unknown>;
  error?: { code: string; message: string };
  help?: string;
}
export interface CliResult {
  exitCode: number;
  output: Output;
  json: boolean;
}
class CliError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
  ) {
    super(code);
  }
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const aliases = /^(harbor|summit)\.(reader|requester|operator)$/;
const messages: Record<string, string> = {
  INVALID_ARGUMENTS: 'Arguments are invalid. Use --help.',
  CREDENTIAL_UNAVAILABLE:
    'The selected local credential is unavailable or invalid.',
  DEADLINE_EXCEEDED: 'The overall command deadline expired.',
  TRANSPORT_UNAVAILABLE: 'The local API could not be reached.',
  INVALID_RESPONSE: 'The local API returned an unsupported response.',
  INTERRUPTED: 'The command was interrupted.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'This operation is not permitted.',
  NOT_FOUND: 'Ticket not found.',
  IDEMPOTENCY_CONFLICT: 'This key was already used with different input.',
  INVALID_REQUEST: 'Request is invalid.',
  PAYLOAD_TOO_LARGE: 'Request body exceeds the allowed size.',
  UNSUPPORTED_MEDIA_TYPE: 'The API rejected the request media type.',
  RATE_LIMITED: 'Request limit exceeded.',
  DEPENDENCY_UNAVAILABLE: 'A required dependency is unavailable.',
  INTERNAL_ERROR: 'An internal error occurred.',
  EXECUTION_FAILED: 'Execution failed.',
  ATTEMPTS_EXHAUSTED: 'Execution attempts exhausted.',
};
export const help =
  'Usage: cli demo | ticket create --message <text> [--key <key>] | ticket get <id> | ticket wait <id>\nOptions: --identity <alias> --deadline <1..300 seconds> --json --no-color --help\nDefault identity: harbor.requester. Endpoint: fixed local http://api:3000. Results are simulated.\nReplay, scenarios and evaluation are not implemented.';
function invalid(): never {
  throw new CliError('INVALID_ARGUMENTS', 2);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError('INVALID_RESPONSE', 4);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= max &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !value.includes('\0')
  );
}
type Command = 'demo' | 'ticket create' | 'ticket get' | 'ticket wait';
function parse(args: string[]):
  | { command: 'help'; json: boolean }
  | {
      command: Command;
      json: boolean;
      identity: string;
      deadline: number;
      id: string | undefined;
      message: string | undefined;
      key: string | undefined;
    } {
  // Reject duplicate switches explicitly; repeated identity/key selection must
  // never silently change which credential or retry key is used.
  const switches = args
    .filter((value) => value.startsWith('--'))
    .map((value) => value.split('=')[0]);
  if (new Set(switches).size !== switches.length) invalid();
  if (args.includes('--help'))
    return { command: 'help', json: args.includes('--json') };
  const program = new Commander()
    .name('cli')
    .exitOverride()
    .helpOption(false)
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option('--identity <alias>', 'Local identity alias', 'harbor.requester')
    .option('--deadline <seconds>', 'Overall deadline', '60')
    .option('--json')
    .option('--no-color');
  let selected: Commander | undefined, id: string | undefined;
  program
    .command('demo')
    .option('--key <key>')
    .action((_options: unknown, command: Commander) => {
      selected = command;
    });
  const group = program.command('ticket');
  group
    .command('create')
    .requiredOption('--message <text>')
    .option('--key <key>')
    .action((_options: unknown, command: Commander) => {
      selected = command;
    });
  for (const name of ['get', 'wait'])
    group
      .command(name)
      .argument('<ticket-id>')
      .action((value: string, _options: unknown, command: Commander) => {
        selected = command;
        id = value;
      });
  try {
    program.parse(args, { from: 'user' });
  } catch {
    invalid();
  }
  if (!selected) invalid();
  const command = (
    selected.name() === 'demo' ? 'demo' : `ticket ${selected.name()}`
  ) as Command;
  const options = selected.optsWithGlobals<Record<string, string | boolean>>();
  const submit = command === 'ticket create' || command === 'demo';
  if (id !== undefined) {
    if (!uuid.test(id)) invalid();
    id = id.toLowerCase();
  }
  const message =
    command === 'demo'
      ? 'What documentation supports resolving this fictional support ticket?'
      : typeof options.message === 'string'
        ? options.message.trim()
        : undefined;
  if (submit && (!text(message, 16000) || Array.from(message).length > 4000))
    invalid();
  const key = typeof options.key === 'string' ? options.key : undefined;
  if (key !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(key)) invalid();
  const identity = String(options.identity);
  if (!aliases.test(identity)) invalid();
  const seconds = String(options.deadline);
  if (
    !/^\d{1,3}$/.test(seconds) ||
    Number(seconds) < 1 ||
    Number(seconds) > 300
  )
    invalid();
  return {
    command,
    id,
    message,
    key,
    identity,
    deadline: Number(seconds) * 1000,
    json: options.json === true,
  } as const;
}
function receipt(value: unknown): Record<string, unknown> {
  const v = object(value);
  if (
    typeof v.ticketId !== 'string' ||
    !uuid.test(v.ticketId) ||
    v.generation !== 1 ||
    v.statusUrl !== `/v1/tickets/${v.ticketId}`
  )
    throw new CliError('INVALID_RESPONSE', 4);
  return { ticketId: v.ticketId, generation: 1, statusUrl: v.statusUrl };
}
function ticket(value: unknown, expectedId: string): Record<string, unknown> {
  const v = object(value);
  if (
    v.ticketId !== expectedId ||
    !Number.isSafeInteger(v.generation) ||
    (v.generation as number) < 1 ||
    typeof v.createdAt !== 'string' ||
    typeof v.updatedAt !== 'string' ||
    v.createdAt.length > 32 ||
    v.updatedAt.length > 32 ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Number.isFinite(Date.parse(v.updatedAt))
  )
    throw new CliError('INVALID_RESPONSE', 4);
  const base = {
    ticketId: v.ticketId,
    generation: v.generation,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    status: v.status,
  };
  if (
    (v.status === 'queued' || v.status === 'processing') &&
    v.result === null &&
    v.failure === null
  )
    return { ...base, result: null, failure: null };
  if (v.status === 'completed' && v.failure === null) {
    const r = object(v.result),
      e = object(r.execution);
    if (
      r.outcome !== 'insufficient_evidence' ||
      !text(r.answer, 8192) ||
      !Array.isArray(r.citations) ||
      r.citations.length ||
      e.providerMode !== 'simulated' ||
      !Number.isSafeInteger(e.attemptCount) ||
      (e.attemptCount as number) < 1 ||
      !Array.isArray(e.toolCalls) ||
      e.toolCalls.length
    )
      throw new CliError('INVALID_RESPONSE', 4);
    return {
      ...base,
      failure: null,
      result: {
        outcome: r.outcome,
        answer: r.answer,
        citations: [],
        execution: {
          providerMode: 'simulated',
          attemptCount: e.attemptCount,
          toolCalls: [],
        },
      },
    };
  }
  if (v.status === 'failed' && v.result === null) {
    const f = object(v.failure);
    if (f.code !== 'EXECUTION_FAILED' && f.code !== 'ATTEMPTS_EXHAUSTED')
      throw new CliError('INVALID_RESPONSE', 4);
    return {
      ...base,
      result: null,
      failure: { code: f.code, message: messages[f.code] },
    };
  }
  throw new CliError('INVALID_RESPONSE', 4);
}
const errorCodes: Record<number, string[]> = {
  400: ['INVALID_REQUEST'],
  401: ['UNAUTHENTICATED'],
  403: ['FORBIDDEN'],
  404: ['NOT_FOUND'],
  409: ['IDEMPOTENCY_CONFLICT'],
  413: ['PAYLOAD_TOO_LARGE'],
  415: ['UNSUPPORTED_MEDIA_TYPE'],
  429: ['RATE_LIMITED'],
  500: ['INTERNAL_ERROR'],
  503: ['DEPENDENCY_UNAVAILABLE'],
};
export async function runCli(
  args: string[],
  deps: Dependencies,
): Promise<CliResult> {
  const now = deps.now ?? (() => performance.now()),
    started = now();
  const output: Output = {
    schemaVersion: 1,
    command: 'unknown',
    outcome: 'error',
    elapsedMs: 0,
  };
  let json = args.includes('--json'),
    exitCode = 0;
  try {
    const p = parse(args);
    json = p.json;
    output.command = p.command;
    if (p.command === 'help') {
      output.outcome = 'help';
      output.help = help;
    } else {
      output.identity = p.identity;
      if (p.command === 'ticket create' || p.command === 'demo')
        output.key = p.key ?? (deps.key ?? randomUUID)();
      const expires = started + p.deadline;
      const message = p.message;
      function remaining() {
        if (deps.signal?.aborted) throw new CliError('INTERRUPTED', 4);
        const left = Math.floor(expires - now());
        if (left <= 0) throw new CliError('DEADLINE_EXCEEDED', 5);
        return left;
      }
      const sleep = async (ms: number) => {
        ms = Math.min(ms, remaining());
        if (deps.delay) await deps.delay(ms);
        else
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              deps.signal?.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, ms);
            deps.signal?.addEventListener('abort', done, { once: true });
            if (deps.signal?.aborted) done();
          });
        remaining();
      };
      let credential: Credential;
      try {
        credential = await deps.credential(p.identity);
      } catch {
        throw new CliError('CREDENTIAL_UNAVAILABLE', 3);
      }
      remaining();
      async function request(id?: string): Promise<unknown> {
        for (let attempt = 0; ; attempt++) {
          const left = remaining();
          let response: Response;
          try {
            response = await (deps.fetch ?? fetch)(
              `http://api:3000/v1/tickets${id === undefined ? '' : '/' + id}`,
              {
                method: id === undefined ? 'POST' : 'GET',
                redirect: 'manual',
                headers: {
                  authorization: `Bearer ${credential.lookupId}.${credential.secret}`,
                  ...(id === undefined
                    ? {
                        'content-type': 'application/json',
                        'idempotency-key': output.key!,
                      }
                    : {}),
                },
                ...(id === undefined
                  ? { body: JSON.stringify({ message }) }
                  : {}),
                signal: AbortSignal.any([
                  AbortSignal.timeout(Math.min(5000, left)),
                  ...(deps.signal ? [deps.signal] : []),
                ]),
              },
            );
          } catch {
            remaining();
            if (attempt >= 2) throw new CliError('TRANSPORT_UNAVAILABLE', 4);
            await sleep(250 * (attempt + 1));
            continue;
          }
          remaining();
          if (response.status === 503 && attempt < 2) {
            await response.body?.cancel();
            const header = response.headers.get('retry-after');
            const seconds =
              header === null
                ? 1
                : /^\d+$/.test(header)
                  ? Number(header)
                  : Math.ceil((Date.parse(header) - Date.now()) / 1000);
            if (!Number.isFinite(seconds) || seconds < 0 || seconds > 5)
              throw new CliError('DEPENDENCY_UNAVAILABLE', 4);
            await sleep(Math.max(250, seconds * 1000));
            continue;
          }
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new CliError('INVALID_RESPONSE', 4);
          }
          let value: unknown;
          try {
            const reader = response.body?.getReader();
            if (!reader) throw new CliError('INVALID_RESPONSE', 4);
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              for (;;) {
                const chunk = await reader.read().catch(() => {
                  throw new CliError('TRANSPORT_UNAVAILABLE', 4);
                });
                if (chunk.done) break;
                size += chunk.value.length;
                if (size > 32768) throw new CliError('INVALID_RESPONSE', 4);
                chunks.push(chunk.value);
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
            value = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            );
          } catch (error) {
            remaining();
            if (
              error instanceof CliError &&
              error.code === 'TRANSPORT_UNAVAILABLE'
            ) {
              if (attempt >= 2) throw error;
              await sleep(250 * (attempt + 1));
              continue;
            }
            throw new CliError('INVALID_RESPONSE', 4);
          }
          remaining();
          const requestId = response.headers.get('x-request-id');
          if (requestId && uuid.test(requestId)) output.requestId = requestId;
          // Never return raw API errors or unknown response fields.
          if (response.status !== (id === undefined ? 202 : 200)) {
            const code = object(object(value).error).code;
            if (
              typeof code !== 'string' ||
              !errorCodes[response.status]?.includes(code)
            )
              throw new CliError('INVALID_RESPONSE', 4);
            throw new CliError(
              code,
              response.status === 401 || response.status === 403
                ? 3
                : response.status < 500
                  ? 2
                  : 4,
            );
          }
          return value;
        }
      }
      let id = p.id;
      if (output.key !== undefined) {
        output.ticket = receipt(await request());
        output.outcome = 'accepted';
        id = output.ticket.ticketId as string;
      }
      if (p.command !== 'ticket create') {
        for (;;) {
          output.ticket = ticket(await request(id), id!);
          const status = output.ticket.status;
          if (p.command === 'ticket get') {
            output.outcome = 'observed';
            break;
          }
          if (status === 'completed') {
            output.outcome = 'completed';
            break;
          }
          if (status === 'failed') {
            const code = object(output.ticket.failure).code as string;
            throw new CliError(code, 1);
          }
          deps.progress?.(status as 'queued' | 'processing');
          await sleep(1000);
        }
      }
      // The private volume is trusted, but echoed selected credentials still fail closed.
      if (JSON.stringify(output).includes(credential.secret)) {
        delete output.ticket;
        throw new CliError('INVALID_RESPONSE', 4);
      }
    }
  } catch (error) {
    const e =
      error instanceof CliError ? error : new CliError('INVALID_RESPONSE', 4);
    output.outcome = 'error';
    output.error = { code: e.code, message: messages[e.code]! };
    exitCode = e.exitCode;
  }
  output.elapsedMs = Math.max(0, Math.floor(now() - started));
  return { exitCode, output, json };
}
