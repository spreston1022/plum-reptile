import { ZuploContext, ZuploRequest } from "@zuplo/runtime";
import { buildSchema, graphql } from "graphql";

/**
 * Self-contained GraphQL backend with a recursive Node type.
 *
 * Schema:
 *   type Node { id, name, level, child: Node, children(count): [Node] }
 *
 * Every request sleeps for ORIGIN_DELAY_MS before responding, simulating a
 * slow backend. Cache HITs are served by the inbound policy before reaching
 * this handler, so they are unaffected by the delay — making the latency
 * difference between a HIT and a MISS immediately visible.
 *
 * Nesting: each child field is a thunk, so the executor only evaluates as
 * many levels as the query selects. No server-side depth limit.
 */

const ORIGIN_DELAY_MS = 1000;

const schema = buildSchema(`
  type Query {
    node(id: ID!): Node
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
    child: () => makeNode(`${id}.c`, level + 1),
    children: ({ count = 3 }: { count?: number }) =>
      Array.from({ length: count }, (_, i) => makeNode(`${id}.${i}`, level + 1)),
  };
}

const rootValue = {
  node: ({ id }: { id: string }) => makeNode(id, 0),
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

  // Simulate a slow origin — every cache miss pays this cost.
  // Cache hits never reach this handler.
  await new Promise((resolve) => setTimeout(resolve, ORIGIN_DELAY_MS));

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
