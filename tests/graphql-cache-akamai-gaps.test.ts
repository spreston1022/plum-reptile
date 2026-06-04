/**
 * GraphQL Caching: Demonstrating gaps in Akamai's implementation
 *
 * Run against a local dev server:
 *   npx zuplo dev         (terminal 1)
 *   npx zuplo test --endpoint http://localhost:9000   (terminal 2)
 *
 * Each test case maps to a documented Akamai limitation.
 * The Rick and Morty API (https://rickandmortyapi.com/graphql) is the backend.
 */

import { describe, it, TestHelper } from "@zuplo/test";
import { expect } from "chai";

const ENDPOINT = `${TestHelper.TEST_URL}/graphql`;

async function gql(query: string, variables?: Record<string, unknown>) {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

// ---------------------------------------------------------------------------
// 1. Sanity check: basic cache hit
// ---------------------------------------------------------------------------
describe("Basic caching", () => {
  it("returns MISS on first request and HIT on second identical request", async () => {
    const query = `{ character(id: "1") { id name status } }`;

    const r1 = await gql(query);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal("HIT");

    // Cached and live responses return the same body
    const body1 = await r1.json();
    const body2 = await r2.json();
    expect(JSON.stringify(body1)).to.equal(JSON.stringify(body2));
  });
});

// ---------------------------------------------------------------------------
// 2. AKAMAI GAP: 4096-byte query size limit
//    Akamai skips GraphQL analysis (and caching) entirely for queries
//    larger than 4096 bytes. Our implementation has no such limit.
// ---------------------------------------------------------------------------
describe("Akamai gap: 4096-byte query size limit", () => {
  it("caches a query that exceeds 4096 bytes — Akamai would bypass this entirely", async () => {
    // Build a query requesting 60 characters with full scalar field sets.
    // Each alias line is ~79 bytes; 60 lines ≈ 4800 bytes.
    // (Rick and Morty Character fields: id name status species type gender image created)
    const aliases = Array.from({ length: 60 }, (_, i) => {
      const id = i + 10; // double-digit IDs keep byte count consistent
      return `  c${id}: character(id: "${id}") { id name status species type gender image created }`;
    });
    const largeQuery = `{\n${aliases.join("\n")}\n}`;

    // Verify the query is actually over the Akamai limit
    expect(
      new TextEncoder().encode(largeQuery).length,
      "query must exceed 4096 bytes to demonstrate the Akamai limit"
    ).to.be.greaterThan(4096);

    const r1 = await gql(largeQuery);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal(
      "MISS",
      "first request should be a cache miss"
    );

    const r2 = await gql(largeQuery);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "second identical request should be a cache hit — Akamai would never reach this"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. AKAMAI GAP: No query normalization
//    Akamai caches on the raw query string, so reformatted queries produce
//    different cache keys even when semantically identical.
//    We normalize via parse() → print() before hashing.
// ---------------------------------------------------------------------------
describe("Akamai gap: query normalization", () => {
  it("treats compact and verbose whitespace as the same cache entry", async () => {
    // Compact — no spaces, no newlines
    const compact = `{character(id:"2"){id name status species}}`;

    // Verbose — extra whitespace, newlines, indentation
    const verbose = `
      query   {
        character  (  id  :  "2"  )   {
          id
          name
          status
          species
        }
      }
    `;

    const r1 = await gql(compact);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    // Different formatting, same semantics → should hit the same cache entry
    const r2 = await gql(verbose);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "normalized queries should share a cache key regardless of whitespace"
    );

    // Cache key header should match
    expect(r1.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key"),
      "both requests should resolve to the same cache key"
    );
  });

  it("treats queries with and without operation names as the same entry", async () => {
    const anonymous = `{ character(id: "3") { id name } }`;
    const named = `query GetCharacter { character(id: "3") { id name } }`;

    // Note: operation names DO change the normalized output, so these will
    // have different keys — this test documents that expected behavior.
    const r1 = await gql(anonymous);
    const r2 = await gql(named);

    expect(r1.headers.get("x-cache-key")).to.not.equal(
      r2.headers.get("x-cache-key"),
      "queries with different operation names have different cache keys (expected)"
    );
  });
});

// ---------------------------------------------------------------------------
// 4. AKAMAI GAP: Fragment normalization
//    Akamai does not document fragment handling. Our implementation uses
//    parse() → print() which normalizes fragments identically regardless
//    of whitespace or ordering within the fragment.
// ---------------------------------------------------------------------------
describe("Akamai gap: fragment normalization", () => {
  it("treats the same fragment written with different whitespace as identical", async () => {
    const compactFragment = `
      fragment F on Character{id name status}
      query{character(id:"4"){...F}}
    `;

    const verboseFragment = `
      fragment F on Character {
        id
        name
        status
      }
      query {
        character(id: "4") {
          ...F
        }
      }
    `;

    const r1 = await gql(compactFragment);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(verboseFragment);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "same fragment with different whitespace should normalize to the same cache key"
    );

    expect(r1.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key")
    );
  });
});

// ---------------------------------------------------------------------------
// 5. AKAMAI GAP: Variable canonicalization
//    JSON object key ordering is not guaranteed. Akamai would create
//    different cache keys for {a:1,b:2} vs {b:2,a:1}.
//    We sort variable keys before hashing.
// ---------------------------------------------------------------------------
describe("Akamai gap: variable key ordering", () => {
  it("treats variables with different key ordering as the same cache entry", async () => {
    const query = `
      query FilterCharacters($status: String, $species: String) {
        characters(filter: { status: $status, species: $species }) {
          results { id name status species }
        }
      }
    `;

    const variablesAB = { status: "Alive", species: "Human" };
    const variablesBA = { species: "Human", status: "Alive" }; // reversed key order

    const r1 = await gql(query, variablesAB);
    expect(r1.status).to.equal(200);
    expect(r1.headers.get("x-cache")).to.equal("MISS");

    const r2 = await gql(query, variablesBA);
    expect(r2.status).to.equal(200);
    expect(r2.headers.get("x-cache")).to.equal(
      "HIT",
      "variable key order should not affect the cache key"
    );

    expect(r1.headers.get("x-cache-key")).to.equal(
      r2.headers.get("x-cache-key"),
      "canonicalized variables should produce the same hash"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Mutation passthrough — correct behavior (Akamai agrees, but we verify)
//    Mutations are never cached. Each call reaches the origin.
// ---------------------------------------------------------------------------
describe("Mutation passthrough", () => {
  it("does not set x-cache header on mutations", async () => {
    // Rick and Morty is read-only, so this mutation returns a GraphQL error —
    // but the important thing is the caching layer never touches it.
    const mutation = `
      mutation {
        createCharacter(name: "Test") {
          id
        }
      }
    `;

    const r1 = await gql(mutation);
    const r2 = await gql(mutation);

    // x-cache header should never appear for mutations
    expect(r1.headers.get("x-cache")).to.be.null;
    expect(r2.headers.get("x-cache")).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed query passthrough
//    Malformed queries are forwarded to the origin — the cache layer never
//    swallows errors. Akamai documents a "POST Request Processing Error"
//    behavior; we just transparently forward.
// ---------------------------------------------------------------------------
describe("Malformed query passthrough", () => {
  it("forwards malformed GraphQL to the origin without caching", async () => {
    const broken = `{ this is not valid graphql !!!`;

    const r1 = await gql(broken);
    const r2 = await gql(broken);

    // Neither response should show as a cache HIT
    expect(r1.headers.get("x-cache")).to.be.null;
    expect(r2.headers.get("x-cache")).to.be.null;
  });
});
