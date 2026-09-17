import { AwsClient } from 'aws4fetch';

export interface S3Object {
  key: string;
  etag: string;
  lastModified: string;
  size: number;
}

export interface S3Env {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY_ID?: string;
  AWS_REGION?: string;
  S3_BUCKET?: string;
  USE_FIXTURES?: string;
}

export class S3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3Error';
  }
}

function endpointFor(env: S3Env) {
  const region = env.AWS_REGION || 'us-east-1';
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new S3Error('S3_BUCKET is not configured');
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function client(env: S3Env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY_ID;
  if (!accessKeyId || !secretAccessKey) {
    throw new S3Error('AWS credentials are not configured');
  }
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: env.AWS_REGION || 'us-east-1',
    service: 's3',
  });
}

/** Parses a ListObjectsV2 XML response into plain objects, skipping the "directory" key S3 returns for a prefix. */
function parseListObjectsXml(xml: string, prefix: string): S3Object[] {
  const objects: S3Object[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsRe.exec(xml))) {
    const block = match[1];
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const etag = block.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1];
    const lastModified = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
    const size = block.match(/<Size>([\s\S]*?)<\/Size>/)?.[1];
    if (!key || key === prefix) continue;
    objects.push({
      key: decodeXmlEntities(key),
      etag: (etag || '').replace(/"/g, ''),
      lastModified: lastModified || '',
      size: size ? Number(size) : 0,
    });
  }
  return objects;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** fixtures/reports/**, fixtures/reports-json/** and fixtures/summaries/** stand in for the bucket when USE_FIXTURES is set, so the index, the structured report view and the summary cards can be exercised without any AWS call. */
// Bundled at build time via Vite's glob import — workerd (including the
// wrangler platform proxy `astro dev` runs on) has no access to the real
// filesystem, so fixtures can't be read with node:fs at request time even
// in local dev. Eager + ?raw inlines the file contents as plain strings.
const fixtureFiles = {
  ...(import.meta.glob('/fixtures/reports/**/*.md', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>),
  // Report JSON and summary envelopes are globbed as ?raw too, not as JSON
  // modules: getObject's contract is "the object's bytes as text", and the
  // caller parses. It also keeps `markdown_sha256` verifiable — a JSON module
  // would round-trip through Vite's serializer and could not be trusted to be
  // byte-identical to what the bucket holds.
  ...(import.meta.glob('/fixtures/reports-json/**/*.json', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>),
  ...(import.meta.glob('/fixtures/summaries/**/*.json', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>),
};

function fixtureContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function listFixtureObjects(prefix: string): S3Object[] {
  const entries = Object.entries(fixtureFiles)
    .map(([path, content]) => ({ key: path.replace(/^\/fixtures\//, ''), content }))
    .filter((e) => e.key.startsWith(prefix))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return entries.map(({ key, content }, i) => {
    const date = /(\d{4}-\d{2}-\d{2})/.exec(key)?.[1] ?? '2026-01-01';
    return {
      key,
      etag: fixtureContentHash(content),
      // Distinct per file so two same-day fixtures (a Tuesday double) still tiebreak deterministically.
      lastModified: new Date(`${date}T12:${String(i).padStart(2, '0')}:00.000Z`).toISOString(),
      size: content.length,
    };
  });
}

function getFixtureObject(key: string): string {
  const content = fixtureFiles[`/fixtures/${key}`];
  if (content === undefined) throw new S3Error(`GetObject failed for ${key}: fixture not found`);
  return content;
}

export async function listObjects(env: S3Env, prefix: string): Promise<S3Object[]> {
  if (env.USE_FIXTURES) return listFixtureObjects(prefix);

  const aws = client(env);
  const url = new URL(endpointFor(env));
  url.searchParams.set('list-type', '2');
  url.searchParams.set('prefix', prefix);

  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  do {
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);
    else url.searchParams.delete('continuation-token');

    const res = await aws.fetch(url.toString());
    if (!res.ok) {
      throw new S3Error(`ListObjectsV2 failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    objects.push(...parseListObjectsXml(xml, prefix));

    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = isTruncated
      ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (continuationToken);

  return objects;
}

export async function getObject(env: S3Env, key: string): Promise<string> {
  if (env.USE_FIXTURES) return getFixtureObject(key);

  const aws = client(env);
  const url = `${endpointFor(env)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const res = await aws.fetch(url);
  if (!res.ok) {
    throw new S3Error(`GetObject failed for ${key}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
