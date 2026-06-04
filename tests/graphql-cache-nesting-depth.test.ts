/**
 * Nesting depth + latency tests against the /graphql-mock endpoint.
 *
 * The mock backend always sleeps 1 second before responding, simulating a
 * slow origin. Cache HITs are served by the inbound policy before the request
 * reaches the handler, so they pay zero origin cost.
 *
 * Akamai's default: 20 levels. Configurable max: 100 levels.
 * Queries exceeding those limits have GraphQL analysis skipped — Akamai
 * treats them as plain POST requests and does not cache them.
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
const ORIGIN_DELAY_MS = 1000; // must match ORIGIN_DELAY_MS in graphql-mock-handler.ts

async function gql(query: string, variables?: Record<string, unknown>) {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

async function timedGql(query: string, variables?: Record<string, unknown>) {
  const start = Date.now();
  const response = await gql(query, variables);
  const elapsed = Date.now() - start;
  return { response, elapsed };
}

/**
 * Build a query that nests `child` selections `depth` times inside `node`.
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
    const depth = 19; // 1 outer + 1 node + 19 child = 21 levels
    const query = buildDeepQuery("depth-21", depth);

    const actualDepth = (query.match(/\{/g) ?? []).length;
    expect(actualDepth).to.be.greaterThan(20);

    const r1 = await gql(query);
    expect(r1.status).to.equal(200, "mock backend returns 200 at any depth");

    const body = await r1.json();
    expect(body.data?.node).to.exist;
    expect(body.errors).to.be.undefined;
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "second request hits the cache — impossible on Akamai past 20 levels"
    );

    // Walk down to the deepest child and verify it resolved correctly
    const cachedBody = await r2.json();
    let cursor = cachedBody.data.node;
    for (let i = 0; i < depth; i++) {
      expect(cursor.child, `child should exist at depth ${i + 1}`).to.exist;
      cursor = cursor.child;
    }
    expect(cursor.level).to.equal(depth);
  });

  it("caches a 25-level query — well beyond Akamai's default", async () => {
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
    for (let i = 0; i < depth; i++) cursor = cursor.child;
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
    expect(r2.headers.get("x-cache")).to.equal("HIT");

    // Verify normalization still works at this depth
    const queryVerbose = buildDeepQuery("depth-50", depth).replace(/\n/g, "\n  ");
    const r3 = await gql(queryVerbose);
    expect(r3.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key"),
      "normalization still works at 50 levels deep"
    );
  });
});

// ---------------------------------------------------------------------------
// Normalization holds at depth
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

    expect(r1.headers.get("x-cache-key")).to.equal(r2.headers.get("x-cache-key"));
  });
});

// ---------------------------------------------------------------------------
// Latency: every miss pays the 1s origin delay; hits do not
// ---------------------------------------------------------------------------
describe("Latency savings — cache hit vs slow origin", () => {
  it(`MISS takes ≥${ORIGIN_DELAY_MS}ms; HIT is served in well under that`, async () => {
    const query = buildDeepQuery("latency-shallow", 5);

    const { response: r1, elapsed: missTime } = await timedGql(query);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");
    expect(missTime).to.be.at.least(ORIGIN_DELAY_MS);

    const { response: r2, elapsed: hitTime } = await timedGql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal("HIT");
    expect(hitTime).to.be.lessThan(ORIGIN_DELAY_MS / 2);

    console.log(`  MISS: ${missTime}ms | HIT: ${hitTime}ms | speedup: ${Math.round(missTime / hitTime)}x`);
  });

  it("latency saving holds on a 21-level query (beyond Akamai's limit)", async () => {
    const query = buildDeepQuery("latency-deep", 19);

    const { response: r1, elapsed: missTime } = await timedGql(query);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");
    expect(missTime).to.be.at.least(ORIGIN_DELAY_MS);

    const { response: r2, elapsed: hitTime } = await timedGql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal("HIT");
    expect(hitTime).to.be.lessThan(ORIGIN_DELAY_MS / 2);

    console.log(`  MISS: ${missTime}ms | HIT: ${hitTime}ms | speedup: ${Math.round(missTime / hitTime)}x`);
  });
});
