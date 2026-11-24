import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TicketAccessError, type TicketService } from './ticket-access';
import { TicketSubmissionError } from './ticket-submission';
import { TicketReadError } from './ticket-read';
import { TicketReplayError } from './ticket-replay';

export const TICKET_SERVICE = Symbol('ticket-service');
const messages = {
  INVALID_REQUEST: [400, 'Request is invalid.'],
  UNAUTHENTICATED: [401, 'Authentication is required.'],
  FORBIDDEN: [403, 'This operation is not permitted.'],
  NOT_FOUND: [404, 'Ticket not found.'],
  IDEMPOTENCY_CONFLICT: [
    409,
    'This key was already used with different input.',
  ],
  REPLAY_CONFLICT: [409, 'Ticket is not failed at the expected generation.'],
  PAYLOAD_TOO_LARGE: [413, 'Request body exceeds the allowed size.'],
  UNSUPPORTED_MEDIA_TYPE: [
    415,
    'Content type must be application/json with UTF-8 encoding.',
  ],
  RATE_LIMITED: [429, 'Request limit exceeded.'],
  DEPENDENCY_UNAVAILABLE: [503, 'A required dependency is unavailable.'],
  INTERNAL_ERROR: [500, 'An internal error occurred.'],
} as const;
class RequestError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(code);
  }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const media = request.headers['content-type'];
  if (
    typeof media !== 'string' ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      media,
    ) ||
    (request.headers['content-encoding'] &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new RequestError('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers['content-length'];
  if (length && Number(length) > 16384)
    throw new RequestError('PAYLOAD_TOO_LARGE');
  if (request.aborted) throw new RequestError('INVALID_REQUEST');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () => finish(new RequestError('INVALID_REQUEST')),
      3000,
    );
    function finish(error?: Error): void {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', aborted);
      if (error) {
        request.pause();
        request.once('error', () => {});
        reject(error);
      } else resolve(Buffer.concat(chunks));
    }
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > 16384) finish(new RequestError('PAYLOAD_TOO_LARGE'));
      else chunks.push(chunk);
    }
    function end(): void {
      finish();
    }
    function aborted(): void {
      finish(new RequestError('INVALID_REQUEST'));
    }
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', aborted);
  });
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RequestError('INVALID_REQUEST');
  }
}

@Controller('v1/tickets')
export class TicketController {
  constructor(
    @Inject(TICKET_SERVICE) private readonly service: TicketService | null,
  ) {}
  @Post()
  async submit(
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const requestId = this.headers(response);
    try {
      const { service, identity } = await this.identify(request);
      if (!['requester', 'operator'].includes(identity.role))
        throw new RequestError('FORBIDDEN');
      await service.checkSubmissionLimit(identity);
      if (
        request.rawHeaders.filter(
          (value, index) =>
            index % 2 === 0 && value.toLowerCase() === 'idempotency-key',
        ).length > 1
      )
        throw new RequestError('INVALID_REQUEST');
      const body = await jsonBody(request);
      const receipt = await service.submit({
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        requestId,
        key: request.headers['idempotency-key'],
        body,
      });
      response.statusCode = 202;
      response.setHeader('Location', receipt.statusUrl);
      response.end(JSON.stringify(receipt));
    } catch (error) {
      this.failure(response, error, requestId);
    }
  }
  @Post(':ticketId/replays')
  async replay(
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
    @Param('ticketId') ticketId: string,
  ): Promise<void> {
    const requestId = this.headers(response);
    try {
      const { service, identity } = await this.identify(request);
      if (identity.role !== 'operator') throw new RequestError('FORBIDDEN');
      // Replay consumes the same mutation/principal budget as submission.
      await service.checkSubmissionLimit(identity);
      if (
        request.rawHeaders.filter(
          (value, index) =>
            index % 2 === 0 && value.toLowerCase() === 'idempotency-key',
        ).length > 1
      )
        throw new RequestError('INVALID_REQUEST');
      const body = await jsonBody(request);
      const receipt = await service.replay({
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        ticketId,
        requestId,
        key: request.headers['idempotency-key'],
        body,
      });
      response.statusCode = 202;
      response.setHeader('Location', receipt.statusUrl);
      response.end(JSON.stringify(receipt));
    } catch (error) {
      this.failure(response, error, requestId);
    }
  }
  @Get(':ticketId')
  async read(
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
    @Param('ticketId') ticketId: string,
  ): Promise<void> {
    const requestId = this.headers(response);
    try {
      const { service, identity } = await this.identify(request);
      await service.checkReadLimit(identity);
      const ticket = await service.getTicket(identity, ticketId);
      response.statusCode = 200;
      response.end(JSON.stringify(ticket));
    } catch (error) {
      this.failure(response, error, requestId);
    }
  }
  private headers(response: ServerResponse): string {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return requestId;
  }
  private async identify(request: IncomingMessage) {
    const service = this.service;
    if (!service) throw new TicketAccessError('DEPENDENCY_UNAVAILABLE');
    await service.checkIngress(request.socket.remoteAddress ?? 'unknown');
    if (
      request.rawHeaders.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === 'authorization',
      ).length > 1
    )
      throw new TicketAccessError('UNAUTHENTICATED');
    const identity = await service.authenticate(request.headers.authorization);
    return { service, identity };
  }
  private failure(
    response: ServerResponse,
    error: unknown,
    requestId: string,
  ): void {
    const code =
      error instanceof RequestError ||
      error instanceof TicketAccessError ||
      error instanceof TicketSubmissionError ||
      error instanceof TicketReadError ||
      error instanceof TicketReplayError
        ? error.code
        : 'INTERNAL_ERROR';
    const [status, message] = messages[code];
    response.statusCode = status;
    response.setHeader('Connection', 'close');
    if (code === 'UNAUTHENTICATED')
      response.setHeader('WWW-Authenticate', 'Bearer');
    if (code === 'DEPENDENCY_UNAVAILABLE')
      response.setHeader('Retry-After', '1');
    if (code === 'RATE_LIMITED' && error instanceof TicketAccessError)
      response.setHeader('Retry-After', String(error.retryAfter ?? 1));
    response.end(JSON.stringify({ error: { code, message, requestId } }));
  }
}
