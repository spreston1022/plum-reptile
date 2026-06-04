import { ZuploContext, ZuploRequest, ZoneCache } from "@zuplo/runtime";
import { parse, print, Kind, OperationDefinitionNode } from "graphql";

const CACHE_NAME = "graphql-responses";
const DEFAULT_TTL_SECONDS = 60;

interface CachedEntry {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Recursively sort object keys so {b:2,a:1} and {a:1,b:2} hash identically
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])])
  );
}

async function buildCacheKey(
  normalizedQuery: string,
  variables: unknown
): Promise<string> {
  const raw =
    normalizedQuery + "\0" + JSON.stringify(canonicalize(variables) ?? null);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function graphqlCachePolicy(
  request: ZuploRequest,
  context: ZuploContext
): Promise<ZuploRequest | Response> {
  // Consume and preserve the body
  const bodyText = await request.text();

  let parsed: { query?: string; variables?: unknown; operationName?: string };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new ZuploRequest(request, { body: bodyText });
  }

  const { query, variables } = parsed;
  if (!query) {
    return new ZuploRequest(request, { body: bodyText });
  }

  let ast;
  try {
    ast = parse(query);
  } catch {
    // Malformed query — let it through so the origin can return a proper error
    return new ZuploRequest(request, { body: bodyText });
  }

  // Only cache query operations; pass mutations and subscriptions through
  const opDef = ast.definitions.find(
    (d): d is OperationDefinitionNode =>
      d.kind === Kind.OPERATION_DEFINITION
  );
  if (opDef && opDef.operation !== "query") {
    return new ZuploRequest(request, { body: bodyText });
  }

  // print() produces canonical whitespace + field ordering, collapsing fragments
  const normalizedQuery = print(ast);
  const key = await buildCacheKey(normalizedQuery, variables);

  const cache = new ZoneCache<CachedEntry>(CACHE_NAME, context);
  const hit = await cache.get(key);

  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("x-cache", "HIT");
    headers.set("x-cache-key", key.slice(0, 8));
    context.log.info(`graphql-cache HIT key=${key.slice(0, 8)}`);
    return new Response(hit.body, { status: hit.status, headers });
  }

  // Cache miss — register a hook to store the response once it returns from origin
  context.addResponseSendingHook(async (response) => {
    if (response.status !== 200) return response;

    const responseBody = await response.text();
    const headersRecord: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headersRecord[k] = v;
    });

    cache
      .put(
        key,
        { status: response.status, headers: headersRecord, body: responseBody },
        DEFAULT_TTL_SECONDS
      )
      .catch((err) => context.log.error(err));

    const newHeaders = new Headers(response.headers);
    newHeaders.set("x-cache", "MISS");
    newHeaders.set("x-cache-key", key.slice(0, 8));
    context.log.info(`graphql-cache MISS key=${key.slice(0, 8)}`);
    return new Response(responseBody, { status: response.status, headers: newHeaders });
  });

  return new ZuploRequest(request, { body: bodyText });
}
