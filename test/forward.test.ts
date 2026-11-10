import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  BillparseClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real InvoiceParserPro endpoint
 * is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/invoiceparserpro-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const EXCEL_TOOL = "invoice_to_excel";
const CHECK_TOOL = "check_invoice";
const EXTRACT_TOOL = "extract_invoice_data";
const RESULT_TOOL = "get_result";
const READER_TOOLS = [EXCEL_TOOL, CHECK_TOOL, EXTRACT_TOOL];
const ALL_TOOLS = [...READER_TOOLS, RESULT_TOOL];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"job_id\":\"job-123\",\"status\":\"completed\"}" }],
  structuredContent: { job_id: "job-123", status: "completed" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "invoiceparserpro", version: "1.0.1" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new BillparseClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 4 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 4);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 4 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "invoice_to_excel",
      "check_invoice",
      "extract_invoice_data",
      "get_result",
    ]);
  });

  it("carries exactly the fixture's keys on each tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's tool titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Invoice to Excel",
        "Check an invoice's math",
        "Extract invoice data",
        "Get a result",
      ],
    );
  });

  it("carries no required key on the three reader tools", () => {
    for (const tool of TOOL_DEFS.slice(0, 3)) {
      assert.equal("required" in schemaOf(tool), false);
      assert.equal(schemaOf(tool).required, undefined);
    }
  });

  it("requires exactly job_id on get_result", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[3]).required, ["job_id"]);
  });

  it("carries the schema-level title on every tool's inputSchema", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => schemaOf(t).title),
      [
        "invoice_to_excelArguments",
        "check_invoiceArguments",
        "extract_invoice_dataArguments",
        "get_resultArguments",
      ],
    );
  });

  it("carries $defs with ChatGPTFile on the three reader tools only", () => {
    for (const tool of TOOL_DEFS.slice(0, 3)) {
      const defs = schemaOf(tool).$defs;
      assert.ok(defs, "reader tool must carry $defs");
      assert.deepEqual(Object.keys(defs), ["ChatGPTFile"]);
      assert.equal(defs.ChatGPTFile.title, "ChatGPTFile");
      assert.equal(defs.ChatGPTFile.type, "object");
      assert.deepEqual(defs.ChatGPTFile.required, ["download_url", "file_id"]);
      assert.deepEqual(Object.keys(defs.ChatGPTFile.properties), [
        "download_url",
        "file_id",
        "mime_type",
        "file_name",
      ]);
    }
    assert.equal("$defs" in schemaOf(TOOL_DEFS[3]), false);
  });

  it("carries every fixture property, in order, for all four tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 4; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    for (const tool of TOOL_DEFS.slice(0, 3)) {
      assert.deepEqual(Object.keys(schemaOf(tool).properties), [
        "file_url",
        "file_base64",
        "file_name",
        "file",
      ]);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), ["job_id"]);
  });

  it("carries the readers' file argument shapes verbatim", () => {
    for (const tool of TOOL_DEFS.slice(0, 3)) {
      const props = schemaOf(tool).properties;
      assert.deepEqual(props.file_url.anyOf, [{ type: "string" }, { type: "null" }]);
      assert.equal(props.file_url.default, null);
      assert.equal(props.file_url.title, "File Url");
      assert.deepEqual(props.file_base64.anyOf, [{ type: "string" }, { type: "null" }]);
      assert.equal(props.file_base64.title, "File Base64");
      assert.equal(props.file_name.title, "File Name");
      assert.deepEqual(props.file.anyOf, [
        { $ref: "#/$defs/ChatGPTFile" },
        { type: "null" },
      ]);
      assert.equal(props.file.default, null);
      assert.equal(schemaOf(tool).type, "object");
    }
  });

  it("carries get_result's job_id argument shape verbatim", () => {
    const props = schemaOf(TOOL_DEFS[3]).properties;
    assert.equal(props.job_id.type, "string");
    assert.equal(props.job_id.title, "Job Id");
    assert.equal(schemaOf(TOOL_DEFS[3]).type, "object");
  });

  it("carries the fixture's get_result wording in its description", () => {
    assert.match(
      TOOL_DEFS[3].description,
      /without submitting or counting another document/,
    );
    for (const tool of TOOL_DEFS.slice(0, 3)) {
      assert.match(tool.description, /use get_result with its job_id/);
    }
  });

  it("isKnownTool recognises the 4 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("invoice-to-excel"), false);
    assert.equal(isKnownTool("parse_invoice"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/inv.pdf" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://api.invoiceparserpro.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name billparse and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RESULT_TOOL, { job_id: "job-123" });
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "billparse", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    await c.callTool(RESULT_TOOL, { job_id: "job-123" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(CHECK_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the INVOICEPARSERPRO_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new BillparseClient({
      fetchFn: upstream.fetchFn,
      env: { INVOICEPARSERPRO_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(EXTRACT_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(RESULT_TOOL, { job_id: "job-9" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { INVOICEPARSERPRO_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new BillparseClient({
      fetchFn: upstream.fetchFn,
      env: { INVOICEPARSERPRO_MCP_URL: "   " },
    });
    await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer on every request when INVOICEPARSERPRO_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new BillparseClient({
      fetchFn: upstream.fetchFn,
      env: { INVOICEPARSERPRO_API_KEY: "ipp-key-42" },
    });
    await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer ipp-key-42",
      ),
    );
  });

  it("sends no Authorization header when INVOICEPARSERPRO_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header when INVOICEPARSERPRO_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new BillparseClient({
      fetchFn: upstream.fetchFn,
      env: { INVOICEPARSERPRO_API_KEY: "   " },
    });
    await c.callTool(RESULT_TOOL, { job_id: "job-1" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new BillparseClient({
      fetchFn: withKey.fetchFn,
      env: { INVOICEPARSERPRO_API_KEY: "ipp-key-42" },
    });
    await c1.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(withKey.calls.every((call) => call.headers["X-API-Key"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards an invoice_to_excel call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { file_url: "https://example.com/invoice-1042.pdf" };
    await c.callTool(EXCEL_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EXCEL_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a base64 invoice_to_excel call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { file_base64: "JVBERi0xLjQ=", file_name: "invoice-1042.pdf" };
    await c.callTool(EXCEL_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EXCEL_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a check_invoice call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { file_url: "https://example.com/invoice-7.pdf" };
    await c.callTool(CHECK_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHECK_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards an extract_invoice_data call with an attached file verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      file: {
        download_url: "https://files.example.com/inv.pdf",
        file_id: "file-1",
        mime_type: "application/pdf",
        file_name: "inv.pdf",
      },
    };
    await c.callTool(EXTRACT_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EXTRACT_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_result call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RESULT_TOOL, { job_id: "job-123" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RESULT_TOOL);
    assert.deepEqual(params.arguments, { job_id: "job-123" });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "could not read invoice" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(CHECK_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(EXTRACT_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      RESULT_TOOL,
      { job_id: "job-77" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RESULT_TOOL);
    assert.deepEqual(params.arguments, { job_id: "job-77" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as billparse error text", () => {
  it("maps a JSON-RPC error to `billparse error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "parse failed upstream" },
    });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: parse failed upstream");
  });

  it("maps an initialize JSON-RPC error to billparse error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: malformed response");
  });

  it("maps a non-2xx upstream status to billparse error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: HTTP 500");
  });

  it("maps a throwing fetch to billparse error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^billparse error: /);
  });

  it("maps a throwing initialize fetch to billparse error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "billparse error: socket hang up");
  });

  it("maps a timed-out call to billparse error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(EXCEL_TOOL, { file_url: "https://example.com/a.pdf" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^billparse error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, EXCEL_TOOL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, RESULT_TOOL, "job_id=job-1"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid invoice_to_excel call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, EXCEL_TOOL, {
      file_url: "https://example.com/a.pdf",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { file_url: "https://example.com/a.pdf" });
  });

  it("forwards a valid get_result call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, RESULT_TOOL, { job_id: "job-123" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RESULT_TOOL);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, RESULT_TOOL, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([EXCEL_TOOL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([EXCEL_TOOL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
