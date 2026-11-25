import { createHash } from 'node:crypto';
import { z } from 'zod';
export const retrievalProfile = 'lexical-hash-v1' as const;
export const chunkingProfile = 'paragraph-utf8-v1' as const;
export const policyVersion = 'extractive-simulated-v1' as const;
export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function stableId(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
export function lexicalVector(text: string): number[] | null {
  const vector = Array<number>(128).fill(0);
  for (const token of tokens(text))
    vector[
      createHash('sha256').update(token).digest().readUInt32BE(0) % 128
    ]!++;
  const norm = Math.hypot(...vector);
  return norm ? vector.map((value) => value / norm) : null;
}
export interface Chunk {
  id: string;
  ordinal: number;
  content: string;
  digest: string;
  vector: number[] | null;
}
export function chunksFor(
  documentId: string,
  version: string,
  source: string,
): Chunk[] {
  if (
    Buffer.byteLength(source) > 65536 ||
    /[\uD800-\uDFFF]/u.test(source) ||
    source.includes('\0')
  )
    throw Error('Invalid document');
  const paragraphs = source
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean);
  const contents: string[] = [];
  let pending = '';
  const flush = () => {
    if (pending) contents.push(pending);
    pending = '';
  };
  for (const paragraph of paragraphs) {
    if (Buffer.byteLength(paragraph) <= 2048) {
      const combined = pending ? pending + '\n\n' + paragraph : paragraph;
      if (Buffer.byteLength(combined) > 2048) flush();
      pending = pending ? pending + '\n\n' + paragraph : paragraph;
    } else {
      flush();
      const points = Array.from(paragraph);
      let start = 0;
      while (start < points.length) {
        let end = start,
          bytes = 0;
        while (
          end < points.length &&
          bytes + Buffer.byteLength(points[end]!) <= 2048
        )
          bytes += Buffer.byteLength(points[end++]!);
        contents.push(points.slice(start, end).join(''));
        if (end === points.length) break;
        let overlap = end,
          size = 0;
        while (
          overlap > start &&
          size + Buffer.byteLength(points[overlap - 1]!) <= 128
        )
          size += Buffer.byteLength(points[--overlap]!);
        start = Math.max(start + 1, overlap);
      }
    }
  }
  flush();
  return contents.map((content, ordinal) => ({
    id: stableId(`${documentId}\0${version}\0${ordinal}\0${sha256(content)}`),
    ordinal,
    content,
    digest: sha256(content),
    vector: lexicalVector(content),
  }));
}
export interface RetrievalIdentity {
  tenantId: string;
  snapshotId: string;
  profile: string;
  policy: string;
  query: string;
}
export function retrievalCacheKey(identity: RetrievalIdentity): string {
  return sha256(
    JSON.stringify([
      identity.tenantId,
      identity.snapshotId,
      identity.profile,
      identity.policy,
      sha256(identity.query),
    ]),
  );
}
const uuid = z.uuid().transform((value) => value.toLowerCase()),
  version = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const safeText = (max: number) =>
  z
    .string()
    .refine(
      (value) =>
        value.trim().length > 0 &&
        Buffer.byteLength(value) <= max &&
        !value.includes('\0') &&
        !/[\uD800-\uDFFF]/u.test(value),
    );
export const citationSchema = z.strictObject({
  documentId: uuid,
  documentVersion: version,
  chunkId: uuid,
});
export type Citation = z.infer<typeof citationSchema>;
export interface Evidence extends Citation {
  tenantId: string;
  snapshotId: string;
  content: string;
  score: number;
}
export const evidenceResultSchema = z.strictObject({
  outcome: z.enum(['answered', 'insufficient_evidence']),
  answer: safeText(8192),
  citations: z.array(citationSchema).max(5),
});
export type EvidenceResult = z.infer<typeof evidenceResultSchema>;
export function validateEvidenceResult(
  input: unknown,
  context: { tenantId: string; snapshotId: string; evidence: Evidence[] },
): EvidenceResult {
  const parsed = evidenceResultSchema.safeParse(input);
  if (
    !parsed.success ||
    context.evidence.length > 5 ||
    context.evidence.some(
      (x) =>
        x.tenantId !== context.tenantId ||
        x.snapshotId !== context.snapshotId ||
        Buffer.byteLength(x.content) > 2048,
    )
  )
    throw Error('Invalid evidence result');
  const result = parsed.data;
  if (
    (result.outcome === 'answered') !== result.citations.length > 0 ||
    new Set(result.citations.map((x) => x.chunkId)).size !==
      result.citations.length
  )
    throw Error('Invalid evidence result');
  for (const citation of result.citations)
    if (
      !context.evidence.some(
        (x) =>
          x.documentId === citation.documentId &&
          x.documentVersion === citation.documentVersion &&
          x.chunkId === citation.chunkId,
      )
    )
      throw Error('Invalid evidence result');
  return result;
}
export const corpusSchema = z.strictObject({
  version: version,
  tenants: z
    .array(
      z.strictObject({
        tenantId: uuid,
        snapshotId: uuid,
        documents: z
          .array(
            z.strictObject({
              id: uuid,
              version,
              title: safeText(200),
              content: safeText(65536),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(20),
});
export type CorpusManifest = z.infer<typeof corpusSchema>;
export function parseCorpus(input: unknown): CorpusManifest {
  const result = corpusSchema.safeParse(input);
  if (!result.success) throw Error('Invalid corpus manifest');
  const manifest = result.data;
  if (
    Buffer.byteLength(JSON.stringify(manifest)) > 1048576 ||
    new Set(manifest.tenants.map((x) => x.tenantId)).size !==
      manifest.tenants.length ||
    new Set(manifest.tenants.map((x) => x.snapshotId)).size !==
      manifest.tenants.length
  )
    throw Error('Invalid corpus manifest');
  for (const tenant of manifest.tenants)
    if (
      new Set(tenant.documents.map((x) => x.id)).size !==
      tenant.documents.length
    )
      throw Error('Invalid corpus manifest');
  return manifest;
}
