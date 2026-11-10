/**
 * billparse core: a forwarding client for the hosted
 * InvoiceParserPro MCP server.
 *
 * No invoice is read on this machine. tools/list is
 * answered from the literal definitions below, which
 * reproduce a live capture of the upstream server
 * word for word (name, title, description and
 * inputSchema exactly as captured, including the
 * `$defs` block and schema-level `title` the three
 * reader tools carry, and the fact that only
 * `get_result` declares a `required` field). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to
 * https://api.invoiceparserpro.com/mcp and may be
 * replaced with the INVOICEPARSERPRO_MCP_URL
 * environment variable (that override is a labelled
 * reconstruction). When INVOICEPARSERPRO_API_KEY is
 * set, every upstream request carries an
 * `Authorization: Bearer <key>` header (the header
 * name is pinned by the registry record's own remote
 * declaration; the Bearer form and forwarding the key
 * from this env var are labelled reconstructions, as
 * the record pins no package env name and the capture
 * was taken keyless). When it is unset, no key header
 * goes out.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch
 * that throws or times out — become an isError result
 * whose text begins with `billparse error:` (that
 * rendering is a labelled reconstruction). Replies may
 * be plain JSON or SSE (`data:` lines); the JSON-RPC
 * message whose id matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://api.invoiceparserpro.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/invoiceparserpro-tools-original.json;   */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "invoice_to_excel",
    "title": "Invoice to Excel",
    "description": "Read an invoice (PDF, scan or photo) and turn it into a spreadsheet: returns the header fields, the line items and download links to an Excel (.xlsx) and a CSV file, valid for 60 minutes without signing in. Give the file as file_url, file_base64 or (ChatGPT) file. For additional outputs from the same processed invoice, use get_result with its job_id instead of submitting it again.",
    "inputSchema": {
      "properties": {
        "file_url": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "An https link to the invoice (PDF or image) that the server can download.",
          "title": "File Url"
        },
        "file_base64": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The invoice file's bytes, base64-encoded. Use for a local file.",
          "title": "File Base64"
        },
        "file_name": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The file's name, e.g. invoice-1042.pdf (optional).",
          "title": "File Name"
        },
        "file": {
          "anyOf": [
            {
              "$ref": "#/$defs/ChatGPTFile"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "ChatGPT only: the attached file. Other clients use file_url or file_base64."
        }
      },
      "type": "object",
      "$defs": {
        "ChatGPTFile": {
          "description": "ChatGPT's file object (Apps SDK `openai/fileParams`).",
          "properties": {
            "download_url": {
              "title": "Download Url",
              "type": "string"
            },
            "file_id": {
              "title": "File Id",
              "type": "string"
            },
            "mime_type": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Mime Type"
            },
            "file_name": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "File Name"
            }
          },
          "required": [
            "download_url",
            "file_id"
          ],
          "title": "ChatGPTFile",
          "type": "object"
        }
      },
      "title": "invoice_to_excelArguments"
    }
  },
  {
    "name": "check_invoice",
    "title": "Check an invoice's math",
    "description": "Check whether an invoice adds up: each line's quantity times unit price, the lines against the subtotal, the tax against its printed rate, and subtotal plus tax against the total. Returns a one-line verdict and every problem found, with the invoice's own numbers. Give the file as file_url, file_base64 or (ChatGPT) file. For additional outputs from the same processed invoice, use get_result with its job_id instead of submitting it again.",
    "inputSchema": {
      "properties": {
        "file_url": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "An https link to the invoice (PDF or image) that the server can download.",
          "title": "File Url"
        },
        "file_base64": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The invoice file's bytes, base64-encoded. Use for a local file.",
          "title": "File Base64"
        },
        "file_name": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The file's name, e.g. invoice-1042.pdf (optional).",
          "title": "File Name"
        },
        "file": {
          "anyOf": [
            {
              "$ref": "#/$defs/ChatGPTFile"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "ChatGPT only: the attached file. Other clients use file_url or file_base64."
        }
      },
      "type": "object",
      "$defs": {
        "ChatGPTFile": {
          "description": "ChatGPT's file object (Apps SDK `openai/fileParams`).",
          "properties": {
            "download_url": {
              "title": "Download Url",
              "type": "string"
            },
            "file_id": {
              "title": "File Id",
              "type": "string"
            },
            "mime_type": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Mime Type"
            },
            "file_name": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "File Name"
            }
          },
          "required": [
            "download_url",
            "file_id"
          ],
          "title": "ChatGPTFile",
          "type": "object"
        }
      },
      "title": "check_invoiceArguments"
    }
  },
  {
    "name": "extract_invoice_data",
    "title": "Extract invoice data",
    "description": "Extract an invoice's data as structured JSON: vendor and customer, invoice number and dates, PO number, currency, subtotal, discount, shipping, tax and total, tax lines, every line item, and confidence (overall and per field). Give the file as file_url, file_base64 or (ChatGPT) file. For additional outputs from the same processed invoice, use get_result with its job_id instead of submitting it again.",
    "inputSchema": {
      "properties": {
        "file_url": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "An https link to the invoice (PDF or image) that the server can download.",
          "title": "File Url"
        },
        "file_base64": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The invoice file's bytes, base64-encoded. Use for a local file.",
          "title": "File Base64"
        },
        "file_name": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "The file's name, e.g. invoice-1042.pdf (optional).",
          "title": "File Name"
        },
        "file": {
          "anyOf": [
            {
              "$ref": "#/$defs/ChatGPTFile"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "description": "ChatGPT only: the attached file. Other clients use file_url or file_base64."
        }
      },
      "type": "object",
      "$defs": {
        "ChatGPTFile": {
          "description": "ChatGPT's file object (Apps SDK `openai/fileParams`).",
          "properties": {
            "download_url": {
              "title": "Download Url",
              "type": "string"
            },
            "file_id": {
              "title": "File Id",
              "type": "string"
            },
            "mime_type": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "Mime Type"
            },
            "file_name": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ],
              "default": null,
              "title": "File Name"
            }
          },
          "required": [
            "download_url",
            "file_id"
          ],
          "title": "ChatGPTFile",
          "type": "object"
        }
      },
      "title": "extract_invoice_dataArguments"
    }
  },
  {
    "name": "get_result",
    "title": "Get a result",
    "description": "Retrieve an already submitted invoice by the job_id returned by any reader, whether that reader answered processing or completed. Returns the available spreadsheet links, math check and extracted data without submitting or counting another document. Use this for additional outputs from the same invoice instead of calling another reader with the file again.",
    "inputSchema": {
      "properties": {
        "job_id": {
          "description": "The job_id a previous call returned.",
          "title": "Job Id",
          "type": "string"
        }
      },
      "required": [
        "job_id"
      ],
      "type": "object",
      "title": "get_resultArguments"
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `billparse error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class BillparseClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).INVOICEPARSERPRO_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).INVOICEPARSERPRO_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "billparse", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): BillparseClient {
  return new BillparseClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new BillparseClient(deps).callTool(name, args);
}
