# billparse

Invoices arrive as PDFs, scans and phone photos, and the numbers inside them still have to end up somewhere usable. billparse is a small local bridge to the hosted InvoiceParserPro MCP service: you hand it an invoice document and it can turn the document into a spreadsheet, tell you whether the arithmetic on it holds together, pull the contents out as structured data, or fetch the outputs of a document you already submitted.

Nothing is parsed on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged.

## The tools

All four tools work on documents you supply. The three readers accept the invoice in any of three forms: `file_url` (an https link the service can download), `file_base64` (the file's bytes, base64-encoded, optionally with `file_name`), or `file` (a client-attached file object, for clients that support attachments).

- **`invoice_to_excel`** — Reads an invoice and returns its header fields and line items together with download links to an Excel (.xlsx) file and a CSV file. Per the captured description the links stay valid for 60 minutes without signing in, and the call returns a `job_id` for the processed document.
- **`check_invoice`** — Tests whether an invoice adds up: each line's quantity times unit price, the lines against the subtotal, the tax against its printed rate, and subtotal plus tax against the total. Returns a one-line verdict plus every problem it finds, quoted with the invoice's own numbers.
- **`extract_invoice_data`** — Pulls an invoice apart into structured JSON: vendor and customer, invoice number and dates, PO number, currency, subtotal, discount, shipping, tax and total, the tax lines, every line item, and a confidence figure overall and per field.
- **`get_result`** — Given the `job_id` an earlier call returned, retrieves that invoice's available spreadsheet links, math check and extracted data. Use it when you want another output from a document you already sent, instead of submitting — and counting — the same document again.

No tool in this surface buys anything, starts a subscription, checks out, or creates an API key; the inputs are your own documents.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/billparse mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "billparse": {
      "command": "npx",
      "args": ["-y", "@reneturcios/billparse", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/billparse
docker run --rm ghcr.io/cloudcorprecords/billparse get_result '{"job_id":"job-123"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
billparse invoice_to_excel '{"file_url":"https://example.com/invoice-1042.pdf"}'
billparse check_invoice '{"file_base64":"...","file_name":"invoice-1042.pdf"}'
billparse extract_invoice_data '{"file_url":"https://example.com/invoice-1042.pdf"}'
billparse get_result '{"job_id":"job-123"}'
billparse --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `INVOICEPARSERPRO_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://api.invoiceparserpro.com/mcp`. (The override variable is a reconstruction added by this rebuild.)
- `INVOICEPARSERPRO_API_KEY` — When set, its value is sent to the upstream on every request as an `Authorization: Bearer <value>` header. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The variable name and the Bearer form are reconstructions; the hosted service's registry record declares an `Authorization` header but pins no package environment name.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `billparse error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
