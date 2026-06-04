import { useState, useCallback } from "react";

const GATEWAY = "https://plum-reptile-main-ff8caaf.zuplo.app";

function buildLargeQuery(): string {
  const aliases = Array.from({ length: 60 }, (_, i) => {
    const id = i + 10;
    return `  c${id}: character(id: "${id}") { id name status species type gender image created }`;
  });
  return `{\n${aliases.join("\n")}\n}`;
}

function buildDeepQuery(depth: number): string {
  let inner = "id name level";
  for (let i = 0; i < depth; i++) {
    inner = `child { ${inner} }`;
  }
  return `{ node(id: "demo") { ${inner} } }`;
}

type CacheStatus = "HIT" | "MISS" | "NONE";

interface RequestResult {
  cacheStatus: CacheStatus;
  cacheKey: string | null;
  latencyMs: number;
  httpStatus: number;
  error?: string;
}

interface RunResult {
  r1: RequestResult;
  r2: RequestResult;
}

async function sendRequest(
  endpoint: string,
  body: Record<string, unknown>
): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${GATEWAY}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latencyMs = Math.round(performance.now() - start);
    const xCache = res.headers.get("x-cache");
    return {
      cacheStatus: xCache === "HIT" ? "HIT" : xCache === "MISS" ? "MISS" : "NONE",
      cacheKey: res.headers.get("x-cache-key"),
      latencyMs,
      httpStatus: res.status,
    };
  } catch (err) {
    return {
      cacheStatus: "NONE",
      cacheKey: null,
      latencyMs: Math.round(performance.now() - start),
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Scenario {
  id: string;
  title: string;
  akamaiGap: string | null;
  description: string;
  label1: string;
  label2: string;
  run(): Promise<RunResult>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "basic",
    title: "Basic GraphQL Caching",
    akamaiGap: null,
    description:
      "Baseline behavior. The same query sent twice — the first goes to the origin (MISS), the second is served from Zuplo's edge cache (HIT).",
    label1: "First request",
    label2: "Second request (identical query)",
    async run() {
      const body = { query: `{ character(id: "1") { id name status } }` };
      return {
        r1: await sendRequest("graphql", body),
        r2: await sendRequest("graphql", body),
      };
    },
  },
  {
    id: "size-limit",
    title: "No 4,096-Byte Query Size Limit",
    akamaiGap: "Akamai skips caching for queries larger than 4,096 bytes",
    description:
      "A ~4,800-byte query with 60 aliased character fields. Akamai bypasses GraphQL analysis — and caching — above its hard size limit. Zuplo parses and caches it regardless of size.",
    label1: "~4,800-byte query — first request",
    label2: "Same large query — second request",
    async run() {
      const body = { query: buildLargeQuery() };
      return {
        r1: await sendRequest("graphql", body),
        r2: await sendRequest("graphql", body),
      };
    },
  },
  {
    id: "normalization",
    title: "Query Normalization",
    akamaiGap: "Akamai caches on raw string — different whitespace = different cache entries",
    description:
      "The same query in compact formatting (request 1) vs verbose whitespace (request 2). Akamai would create two cache entries. Zuplo normalizes via AST parse + print before hashing — both resolve to the same key.",
    label1: 'Compact: {character(id:"2"){id name status}}',
    label2: "Verbose: query { character ( id : \"2\" ) { ... } }",
    async run() {
      const r1 = await sendRequest("graphql", {
        query: `{character(id:"2"){id name status species}}`,
      });
      const r2 = await sendRequest("graphql", {
        query: `
          query {
            character ( id : "2" ) {
              id
              name
              status
              species
            }
          }
        `,
      });
      return { r1, r2 };
    },
  },
  {
    id: "fragments",
    title: "Fragment Normalization",
    akamaiGap: "Akamai: fragment whitespace differences produce different cache keys",
    description:
      "The same fragment-based query in compact (request 1) vs verbose (request 2) whitespace. Zuplo's AST round-trip normalizes fragment spreads identically regardless of formatting.",
    label1: "Fragment with compact whitespace",
    label2: "Same fragment, verbose whitespace",
    async run() {
      const r1 = await sendRequest("graphql", {
        query: `fragment F on Character{id name status} query{character(id:"4"){...F}}`,
      });
      const r2 = await sendRequest("graphql", {
        query: `
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
        `,
      });
      return { r1, r2 };
    },
  },
  {
    id: "variables",
    title: "Variable Key Canonicalization",
    akamaiGap: 'Akamai: JSON key order affects cache keys — {a,b} and {b,a} are different entries',
    description:
      "The same variables passed with keys in different order. JSON key ordering is not guaranteed. Zuplo sorts variable keys recursively before hashing so both resolve to the same cache entry.",
    label1: '{ status: "Alive", species: "Human" }',
    label2: '{ species: "Human", status: "Alive" } — keys reversed',
    async run() {
      const query = `
        query FilterCharacters($status: String, $species: String) {
          characters(filter: { status: $status, species: $species }) {
            results { id name status species }
          }
        }
      `;
      return {
        r1: await sendRequest("graphql", {
          query,
          variables: { status: "Alive", species: "Human" },
        }),
        r2: await sendRequest("graphql", {
          query,
          variables: { species: "Human", status: "Alive" },
        }),
      };
    },
  },
  {
    id: "nesting",
    title: "Deep Query Nesting (21+ Levels)",
    akamaiGap: "Akamai: queries deeper than 20 levels have caching skipped by default",
    description:
      "A 21-level nested query against a recursive mock backend that supports arbitrary depth. Akamai's default cap is 20 levels — exceeding it falls back to uncached plain POST. Zuplo has no depth limit.",
    label1: "21-level nested query — first request",
    label2: "Same 21-level query — second request",
    async run() {
      const query = buildDeepQuery(19); // 1 outer + 1 node{} + 19 child{} = 21 levels
      return {
        r1: await sendRequest("graphql-mock", { query }),
        r2: await sendRequest("graphql-mock", { query }),
      };
    },
  },
];

// ── sub-components ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      style={{ animation: "spin 1s linear infinite", width: 14, height: 14 }}
      fill="none"
      viewBox="0 0 24 24"
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <circle
        style={{ opacity: 0.25 }}
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        style={{ opacity: 0.75 }}
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CacheBadge({ status }: { status: CacheStatus }) {
  const shared: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 10px",
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    border: "1px solid",
  };
  if (status === "HIT") {
    return (
      <span
        style={{
          ...shared,
          background: "#dcfce7",
          color: "#15803d",
          borderColor: "#bbf7d0",
        }}
      >
        ✓ HIT
      </span>
    );
  }
  if (status === "MISS") {
    return (
      <span
        style={{
          ...shared,
          background: "#fef9c3",
          color: "#a16207",
          borderColor: "#fef08a",
        }}
      >
        → MISS
      </span>
    );
  }
  return (
    <span
      style={{
        ...shared,
        background: "#f3f4f6",
        color: "#9ca3af",
        borderColor: "#e5e7eb",
      }}
    >
      —
    </span>
  );
}

function RequestBox({
  label,
  result,
}: {
  label: string;
  result: RequestResult | null;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 10,
        border: "1px solid #e5e7eb",
        background: "#f9fafb",
        padding: "14px 16px",
      }}
    >
      <p
        title={label}
        style={{
          margin: "0 0 10px",
          fontSize: 11,
          color: "#6b7280",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </p>
      {result === null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9ca3af", fontSize: 13 }}>
          <Spinner />
          Sending…
        </div>
      ) : result.error ? (
        <p style={{ margin: 0, fontSize: 12, color: "#ef4444", wordBreak: "break-all" }}>
          {result.error}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CacheBadge status={result.cacheStatus} />
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "#111827" }}>
              {result.latencyMs}ms
            </span>
          </div>
          {result.cacheKey && (
            <p style={{ margin: 0, fontFamily: "monospace", fontSize: 11, color: "#9ca3af" }}>
              key: <span style={{ color: "#6b7280" }}>{result.cacheKey}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type ScenarioState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: RunResult }
  | { phase: "error"; message: string };

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  const [state, setState] = useState<ScenarioState>({ phase: "idle" });

  const handleRun = useCallback(async () => {
    setState({ phase: "running" });
    try {
      const result = await scenario.run();
      setState({ phase: "done", result });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [scenario]);

  const isDone = state.phase === "done";
  const isRunning = state.phase === "running";

  const keysMatch =
    isDone &&
    state.result.r1.cacheKey !== null &&
    state.result.r2.cacheKey !== null &&
    state.result.r1.cacheKey === state.result.r2.cacheKey;

  const latencySaved =
    isDone && state.result.r2.cacheStatus === "HIT"
      ? state.result.r1.latencyMs - state.result.r2.latencyMs
      : null;

  return (
    <div
      style={{
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      {/* header */}
      <div style={{ padding: "20px 20px 18px", background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {scenario.akamaiGap && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  marginBottom: 10,
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "#fff7ed",
                  color: "#c2410c",
                  border: "1px solid #fed7aa",
                }}
              >
                ⚠ {scenario.akamaiGap}
              </div>
            )}
            <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 700, color: "#111827" }}>
              {scenario.title}
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "#4b5563", lineHeight: 1.6 }}>
              {scenario.description}
            </p>
          </div>
          <button
            onClick={handleRun}
            disabled={isRunning}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              background: isRunning ? "#93c5fd" : "#2563eb",
              color: "#fff",
              border: "none",
              cursor: isRunning ? "default" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {isRunning ? (
              <>
                <Spinner />
                Running…
              </>
            ) : isDone ? (
              "Run Again"
            ) : (
              "▶ Run Test"
            )}
          </button>
        </div>
      </div>

      {/* results */}
      {(isDone || isRunning) && (
        <div
          style={{
            borderTop: "1px solid #e5e7eb",
            background: "#f9fafb",
            padding: "16px 20px 18px",
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
            <RequestBox
              label={scenario.label1}
              result={isDone ? state.result.r1 : null}
            />
            <div style={{ display: "flex", alignItems: "center", color: "#d1d5db", fontSize: 20 }}>
              →
            </div>
            <RequestBox
              label={scenario.label2}
              result={isDone ? state.result.r2 : null}
            />
          </div>

          {isDone && (latencySaved !== null || keysMatch) && (
            <div
              style={{
                marginTop: 14,
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 20px",
                fontSize: 13,
              }}
            >
              {latencySaved !== null && latencySaved > 0 && (
                <span style={{ color: "#15803d", fontWeight: 600 }}>
                  ⚡ {latencySaved}ms saved —{" "}
                  <span style={{ fontWeight: 400 }}>origin round-trip avoided</span>
                </span>
              )}
              {keysMatch && (
                <span style={{ color: "#1d4ed8", fontWeight: 600 }}>
                  ✓ Same cache key —{" "}
                  <span style={{ fontWeight: 400 }}>normalization confirmed</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {state.phase === "error" && (
        <div
          style={{
            borderTop: "1px solid #e5e7eb",
            background: "#fff7f7",
            padding: "14px 20px",
          }}
        >
          <p style={{ margin: "0 0 4px", fontSize: 13, color: "#dc2626" }}>
            {state.message}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>
            If this is a CORS error, ensure the gateway has CORS enabled and the
            deployment is up to date.
          </p>
        </div>
      )}
    </div>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

export function GraphQLCacheDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {SCENARIOS.map((scenario) => (
        <ScenarioCard key={scenario.id} scenario={scenario} />
      ))}
    </div>
  );
}
