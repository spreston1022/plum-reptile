/**
 * Nesting depth tests against the /graphql-mock endpoint.
 *
 * The mock backend uses a recursive Node type with no server-side depth limit,
 * so we can push nesting as deep as we like and observe cache behavior.
 *
 * Akamai's default: 20 levels. Configurable max: 100 levels.
 * Queries that exceed these limits have GraphQL analysis skipped entirely —
 * Akamai treats them as plain POST requests with no caching.
 *
 * Our implementation: no depth limit. Any valid GraphQL query is parsed,
 * normalized, and cached regardless of nesting depth.
 *
 * Run:
 *   npx zuplo dev              (terminal 1)
 *   npx zuplo test --endpoint http://localhost:9000 --filter nesting   (terminal 2)
 */

import { describe, it, TestHelper } from "@zuplo/test";
import { expect } from "chai";

const ENDPOINT = `${TestHelper.TEST_URL}/graphql-mock`;

async function gql(query: string, variables?: Record<string, unknown>) {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

/**
 * Build a query that nests `child` selections `depth` times inside `node`.
 *
 * depth=1  → node { child { id name level } }
 * depth=25 → node { child { child { ... (25 levels) ... { id name level } } } }
 *
 * From Akamai's counting perspective, the outer document brace is level 1,
 * `node {}` is level 2, then each `child {}` adds one more — so depth=19
 * puts the leaf at level 21, exceeding Akamai's default of 20.
 */
function buildDeepQuery(id: string, depth: number): string {
  let inner = "id name level";
  for (let i = 0; i < depth; i++) {
    inner = `child {\n${inner}\n}`;
  }
  return `{ node(id: "${id}") {\n${inner}\n} }`;
}

// ---------------------------------------------------------------------------
// Sanity check: shallow query caches normally
// ---------------------------------------------------------------------------
describe("Nesting depth — shallow (within Akamai limits)", () => {
  it("caches a 5-level query (well within Akamai's 20-level limit)", async () => {
    const query = buildDeepQuery("shallow", 5);

    const r1 = await gql(query);
    expect(r1.status).to.equal(200);
    const body1 = await r1.json();
    expect(body1.data?.node).to.exist;
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal("HIT");
  });
});

// ---------------------------------------------------------------------------
// AKAMAI GAP: Queries deeper than 20 levels
// Akamai skips analysis; we parse, normalize, and cache normally.
// ---------------------------------------------------------------------------
describe("Nesting depth — exceeds Akamai's 20-level default", () => {
  it("caches a 21-level query — Akamai would bypass this entirely", async () => {
    // depth=19 child selections puts the leaf at nesting level 21
    // (1 outer brace + 1 node + 19 child = 21)
    const depth = 19;
    const query = buildDeepQuery("depth-21", depth);

    // Confirm the query is genuinely 21 levels deep
    const actualDepth = (query.match(/\{/g) ?? []).length;
    expect(actualDepth).to.be.greaterThan(20);

    const r1 = await gql(query);
    expect(r1.status).to.equal(200, "mock backend returns 200 at any depth");

    const body = await r1.json();
    expect(body.data?.node).to.exist;
    expect(body.errors).to.be.undefined;

    expect(r1.headers.get("x-cache")).to.equal(
      "MISS",
      "first request is a cache miss"
    );

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "second request hits the cache — impossible on Akamai past 20 levels"
    );

    // Verify the cached body is correct and deep
    const cachedBody = await r2.json();
    expect(cachedBody.data?.node?.level).to.equal(0);

    // Walk down to the deepest child and verify it resolved
    let cursor = cachedBody.data.node;
    for (let i = 0; i < depth; i++) {
      expect(cursor.child, `child should exist at depth ${i + 1}`).to.exist;
      cursor = cursor.child;
    }
    expect(cursor.level).to.equal(depth);
  });

  it("caches a 25-level query — well beyond Akamai's default, near its max", async () => {
    const depth = 23; // leaf lands at level 25
    const query = buildDeepQuery("depth-25", depth);

    const r1 = await gql(query);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal("HIT");

    const cachedBody = await r2.json();
    let cursor = cachedBody.data.node;
    for (let i = 0; i < depth; i++) {
      cursor = cursor.child;
    }
    expect(cursor.level).to.equal(depth);
  });
});

// ---------------------------------------------------------------------------
// AKAMAI GAP: Near the configurable max (100 levels)
// Akamai's maximum (even with custom config) is 100. Ours is unlimited.
// ---------------------------------------------------------------------------
describe("Nesting depth — near Akamai's configurable maximum of 100", () => {
  it("caches a 50-level query — unreachable for Akamai even at its 100-level max config", async () => {
    const depth = 48; // leaf lands at level 50
    const query = buildDeepQuery("depth-50", depth);

    const r1 = await gql(query);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "50-level query is cached — Akamai would require custom config to even parse this, " +
        "and would still fail at its 100-level hard cap"
    );

    // Verify cache key is stable: different formatting, same structure → same key
    const queryVerbose = buildDeepQuery("depth-50", depth).replace(
      /\n/g,
      "\n  "
    );
    const r3 = await gql(queryVerbose);
    expect(r3.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key"),
      "normalization still works at 50 levels deep"
    );
  });
});

// ---------------------------------------------------------------------------
// Normalization works at depth
// Same deep query, different whitespace → same cache key
// ---------------------------------------------------------------------------
describe("Normalization holds at nesting depth", () => {
  it("normalizes a 21-level query across whitespace variants", async () => {
    const depth = 19;
    const compact = buildDeepQuery("norm-deep", depth).replace(/\s+/g, " ");
    const verbose = buildDeepQuery("norm-deep", depth);

    const r1 = await gql(compact);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(verbose);
    expect(r2.headers.get("x-cache")).to.equal("HIT");

    expect(r1.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key"),
      "cache key is the same regardless of whitespace"
    );
  });
});
