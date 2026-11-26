import { z } from 'zod';
import { agentSummarySchema } from '@lab/configuration';
const uuid = z.uuid();
const timestamp = z.iso.datetime();
const generation = z.number().int().min(1).max(2147483647);
const safeText = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        Buffer.byteLength(value) <= bytes &&
        !value.includes('\0') &&
        !/[\uD800-\uDFFF]/u.test(value),
    )
    .meta({ 'x-max-utf8-bytes': bytes });
const citation = z.strictObject({
  documentId: uuid,
  documentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  chunkId: uuid,
});
const legacyExecution = z.strictObject({
  providerMode: z.literal('simulated'),
  attemptCount: z.number().int().min(1),
  toolCalls: z.array(z.never()).length(0),
});
const agentExecution = z
  .strictObject({
    ...agentSummarySchema.shape,
    attemptCount: z.number().int().min(1),
  })
  .refine((value) => value.toolCalls.length < value.modelTurns)
  .meta({
    description:
      'Safe summary only. Tool arguments/results are excluded; tool call count must be less than model turn count.',
  });
const result = z
  .strictObject({
    outcome: z.enum(['answered', 'insufficient_evidence']),
    answer: safeText(8192),
    citations: z.array(citation).max(5),
    execution: z.union([legacyExecution, agentExecution]),
  })
  .refine(
    (value) =>
      (value.outcome === 'answered') === value.citations.length > 0 &&
      new Set(value.citations.map((c) => c.chunkId)).size ===
        value.citations.length,
  )
  .meta({
    description:
      'Answered results require unique citations from actually delivered tenant evidence; abstentions have no citations. Structural validation does not establish semantic quality.',
  });
const ticketBase = {
  ticketId: uuid,
  generation,
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const httpSchemas = {
  SubmitBody: z.strictObject({
    message: z
      .string()
      .min(1)
      .refine((value) => {
        const trimmed = value.trim();
        return (
          trimmed.length > 0 &&
          Array.from(trimmed).length <= 4000 &&
          !value.includes('\0') &&
          !/[\uD800-\uDFFF]/u.test(value)
        );
      })
      .meta({
        description:
          'Trimmed by the server; 1–4000 Unicode code points after trimming. NUL and unpaired surrogates are rejected. The complete encoded request is limited to 16 KiB.',
        'x-trimmed-max-code-points': 4000,
      }),
  }),
  ReplayBody: z.strictObject({
    expectedGeneration: z.number().int().min(1).max(2147483646),
  }),
  Receipt: z
    .strictObject({
      ticketId: uuid,
      generation,
      statusUrl: z.string().regex(/^\/v1\/tickets\/[a-f0-9-]{36}$/),
    })
    .refine((v) => v.statusUrl === '/v1/tickets/' + v.ticketId),
  Ticket: z.union([
    z.strictObject({
      ...ticketBase,
      status: z.enum(['queued', 'processing']),
      result: z.null(),
      failure: z.null(),
    }),
    z.strictObject({
      ...ticketBase,
      status: z.literal('completed'),
      result,
      failure: z.null(),
    }),
    z.strictObject({
      ...ticketBase,
      status: z.literal('failed'),
      result: z.null(),
      failure: z.strictObject({
        code: z.enum(['EXECUTION_FAILED', 'ATTEMPTS_EXHAUSTED']),
        message: safeText(200),
      }),
    }),
  ]),
  Error: z.strictObject({
    error: z.strictObject({
      code: z.enum([
        'INVALID_REQUEST',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'NOT_FOUND',
        'IDEMPOTENCY_CONFLICT',
        'REPLAY_CONFLICT',
        'PAYLOAD_TOO_LARGE',
        'UNSUPPORTED_MEDIA_TYPE',
        'RATE_LIMITED',
        'DEPENDENCY_UNAVAILABLE',
        'INTERNAL_ERROR',
      ]),
      message: safeText(200),
      requestId: uuid,
    }),
  }),
  Live: z.strictObject({ status: z.literal('alive') }),
  Ready: z.strictObject({ status: z.literal('ready') }),
  NotReady: z.strictObject({ status: z.literal('not_ready') }),
};
type SchemaName = keyof typeof httpSchemas;
const ref = (name: SchemaName) => ({ $ref: '#/components/schemas/' + name });
const json = (name: SchemaName) => ({
  'application/json': { schema: ref(name) },
});
const commonHeaders = {
  'Cache-Control': {
    required: true,
    description: 'Business responses are never cacheable.',
    schema: { type: 'string', const: 'no-store' },
  },
  'X-Request-Id': {
    required: true,
    description: 'Server-generated request identifier.',
    schema: { type: 'string', format: 'uuid' },
  },
  traceparent: {
    description: 'Optional canonical version-00 trace context.',
    schema: { type: 'string', pattern: '^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$' },
  },
  'X-Trace-Id': {
    description: 'Optional trace identifier.',
    schema: { type: 'string', pattern: '^[a-f0-9]{32}$' },
  },
};
const errors = {
  400: ['INVALID_REQUEST'],
  401: ['UNAUTHENTICATED'],
  403: ['FORBIDDEN'],
  404: ['NOT_FOUND'],
  409: ['IDEMPOTENCY_CONFLICT', 'REPLAY_CONFLICT'],
  413: ['PAYLOAD_TOO_LARGE'],
  415: ['UNSUPPORTED_MEDIA_TYPE'],
  429: ['RATE_LIMITED'],
  500: ['INTERNAL_ERROR'],
  503: ['DEPENDENCY_UNAVAILABLE'],
} as const;
function errorResponses(statuses: Array<keyof typeof errors>) {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description: errors[status].join(' or '),
        content: json('Error'),
        headers: {
          ...commonHeaders,
          ...(status === 401
            ? {
                'WWW-Authenticate': {
                  required: true,
                  description: 'Bearer challenge.',
                  schema: { type: 'string', const: 'Bearer' },
                },
              }
            : {}),
          ...([429, 503].includes(status)
            ? {
                'Retry-After': {
                  description: 'Integer delay in seconds.',
                  schema: { type: 'string', pattern: '^[0-9]+$' },
                },
              }
            : {}),
        },
      },
    ]),
  );
}
const ticketParameter = {
  name: 'ticketId',
  in: 'path',
  required: true,
  description: 'UUID; authorization always uses the authenticated tenant.',
  schema: { type: 'string', format: 'uuid' },
};
const keyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Case-sensitive key scoped to the authenticated tenant and operation. Reuse for identical retries.',
  schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
};
const accepted = {
  description:
    'Stable acceptance receipt. Processing continues asynchronously.',
  headers: {
    ...commonHeaders,
    Location: {
      required: true,
      description: 'Same path as receipt.statusUrl.',
      schema: { type: 'string', pattern: '^/v1/tickets/[a-f0-9-]{36}$' },
    },
  },
  content: json('Receipt'),
};
export function createOpenApiDocument() {
  const schemas = Object.fromEntries(
    Object.entries(httpSchemas).map(([name, schema]) => {
      const converted = z.toJSONSchema(schema);
      delete converted.$schema;
      return [name, converted];
    }),
  );
  return {
    openapi: '3.1.1',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: {
      title: 'Distributed AI Systems Lab HTTP API',
      version: '0.0.0',
      description:
        'Implemented local HTTP contract. Fictional data and simulated answers; no production release or real-provider support is claimed. JSON Schema cannot express every ownership, UTF-8 byte, trimming or cross-field invariant; descriptions name those server checks.',
    },
    servers: [
      {
        url: 'http://127.0.0.1:3000',
        description:
          'Default loopback publication. Match LAB_API_PORT when configured.',
      },
    ],
    security: [{ BearerAuth: [] }],
    paths: {
      '/health/live': {
        get: {
          operationId: 'healthLive',
          summary: 'Process liveness',
          security: [],
          responses: {
            '200': { description: 'Process is alive.', content: json('Live') },
          },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'healthReady',
          summary: 'Configured dependency readiness',
          security: [],
          responses: {
            '200': {
              description: 'Configured dependencies are ready.',
              content: json('Ready'),
            },
            '503': {
              description: 'A configured dependency is not ready.',
              content: json('NotReady'),
            },
          },
        },
      },
      '/v1/tickets': {
        post: {
          operationId: 'submitTicket',
          summary: 'Accept a tenant-owned ticket',
          description:
            'Requester or operator role. Strict JSON body, at most 16 KiB UTF-8; compressed bodies are unsupported. Tenant/principal fields are derived from authentication and cannot appear in the body.',
          parameters: [keyParameter],
          requestBody: { required: true, content: json('SubmitBody') },
          responses: {
            '202': accepted,
            ...errorResponses([400, 401, 403, 409, 413, 415, 429, 500, 503]),
          },
        },
      },
      '/v1/tickets/{ticketId}': {
        get: {
          operationId: 'readTicket',
          summary: 'Read the current tenant-owned generation',
          description:
            'Reader, requester or operator role. Missing and foreign tickets have the same not-found response. No generation history or listing endpoint is implemented.',
          parameters: [ticketParameter],
          responses: {
            '200': {
              description:
                'Coherent current generation and safe result/failure.',
              headers: commonHeaders,
              content: json('Ticket'),
            },
            ...errorResponses([400, 401, 403, 404, 429, 500, 503]),
          },
        },
      },
      '/v1/tickets/{ticketId}/replays': {
        post: {
          operationId: 'replayTicket',
          summary: 'Accept a new generation for a failed ticket',
          description:
            'Operator role only. Requires the failed current generation to equal expectedGeneration; selects the current corpus/policy for the new generation. Same-key retries return their existing receipt. Shares the tenant mutation budget with submission.',
          parameters: [ticketParameter, keyParameter],
          requestBody: { required: true, content: json('ReplayBody') },
          responses: {
            '202': accepted,
            ...errorResponses([
              400, 401, 403, 404, 409, 413, 415, 429, 500, 503,
            ]),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Opaque local lookup ID and secret. Use the provisioned fictional identity; never submit tenant IDs as authorization.',
        },
      },
      schemas,
    },
  };
}
