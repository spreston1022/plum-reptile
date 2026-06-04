import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { buildSchema, graphql } from "graphql";

/**
 * Self-contained GraphQL backend with a recursive Node type.
 *
 * Schema:
 *   type Query  { node(id, delay): Node }
 *   type Node   { id, name, level, child, children(count) }
 *
 * delay: optional milliseconds the handler sleeps before responding.
 * Use this to simulate a slow origin and make cache hit latency savings visible.
 * The delay only applies on cache misses — hits are served by the cache policy
 * before the request ever reaches this handler.
 *
 * Nesting: each child field is a thunk, so the executor only evaluates as many
 * levels as the query selects. No server-side depth limit — useful for testing
 * beyond Akamai's 20-level default.
 */

const schema = buildSchema(`
  type Query {
    node(id: ID!, delay: Int): Node
  }

  type Node {
    id: ID!
    name: String!
    level: Int!
    child: Node
    children(count: Int): [Node!]!
  }
`);

type NodeShape = {
  id: string;
  name: string;
  level: number;
  child: () => NodeShape;
  children: (args: { count?: number }) => NodeShape[];
};

function makeNode(id: string, level: number): NodeShape {
  return {
    id,
    name: `${id}@L${level}`,
    level,
    // Thunks so the executor only evaluates levels the query selects
    child: () => makeNode(`${id}.c`, level + 1),
    children: ({ count = 3 }: { count?: number }) =>
      Array.from({ length: count }, (_, i) => makeNode(`${id}.${i}`, level + 1)),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rootValue = {
  node: async ({ id, delay }: { id: string; delay?: number }) => {
    if (delay && delay > 0) await sleep(Math.min(delay, 5000));
    return makeNode(id, 0);
  },
};

export default async function graphqlMockHandler(
  request: ZuploRequest,
  _context: ZuploContext
): Promise<Response> {
  let body: {
    query?: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  };

  try {
    body = await request.json();
  } catch {
    return respond({ errors: [{ message: "Request body is not valid JSON" }] }, 400);
  }

  const { query, variables, operationName } = body;
  if (!query) {
    return respond({ errors: [{ message: "Missing 'query' field" }] }, 400);
  }

  const result = await graphql({
    schema,
    source: query,
    rootValue,
    variableValues: variables,
    operationName,
  });

  return respond(result, 200);
}

function respond(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
