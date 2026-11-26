import { z } from 'zod';
export const agentPolicyVersion = 'bounded-agent-v1' as const;
export const agentSummarySchema = z
  .strictObject({
    policy: z.literal(agentPolicyVersion),
    providerMode: z.literal('simulated'),
    modelTurns: z.number().int().min(1).max(4),
    toolCalls: z
      .array(
        z.strictObject({
          name: z.enum([
            'search_documentation',
            'get_service_status',
            'get_ticket',
          ]),
          outcome: z.enum(['observed', 'not_found']),
        }),
      )
      .max(3),
  })
  .refine(
    (value) =>
      value.toolCalls.length < value.modelTurns &&
      Buffer.byteLength(JSON.stringify(value)) <= 4096,
  );
export type AgentSummary = z.infer<typeof agentSummarySchema>;
