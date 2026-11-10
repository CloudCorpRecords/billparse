# BUILD REPORT — billparse

Clean-room rebuild of `com.invoiceparserpro/ipp` v1.0.1 (remote-only MCP
server at `https://api.invoiceparserpro.com/mcp`), built 2026-10-28 as a
forwarding client. Package: `@reneturcios/billparse` 0.1.0,
registry name `io.github.CloudCorpRecords/billparse`.

## Surface built

Full surface built: **4/4 tools**, no omissions.

| Tool | Title (as served) | Required fields as served |
|------|-------------------|-----------------------------|
| `invoice_to_excel` | Invoice to Excel | *(no `required` key in schema)* |
| `check_invoice` | Check an invoice's math | *(no `required` key in schema)* |
| `extract_invoice_data` | Extract invoice data | *(no `required` key in schema)* |
| `get_result` | Get a result | `job_id` |

The three reader tools' inputSchemas carry `$defs` (with `ChatGPTFile`)
and a schema-level `title` (`<tool>Arguments`); those are served verbatim.
`get_result`'s inputSchema carries a schema-level `title` but no `$defs`.
Tool literals were generated programmatically from
`harness/fixtures/invoiceparserpro-tools-original.json` by the script at
`/tmp/b39-billparse-gen.py` (parse + re-serialise, placeholder substitution
into `src/forward.ts`) — never retyped — and a post-generation check
confirmed the served literals deep-equal the fixture's 4 tool objects in
order. Tools are registered via the MCP SDK low-level Server API
(`ListToolsRequestSchema` / `CallToolRequestSchema` handlers), not
McpServer+zod, per the task instruction overriding TEMPLATE.md §2 item 12.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names, order, required
fields, `$defs`/schema-`title` presence, and descriptions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://api.invoiceparserpro.com/mcp`.
- Env override `INVOICEPARSERPRO_MCP_URL` — labelled reconstruction.
- Env name `INVOICEPARSERPRO_API_KEY` — labelled reconstruction (the
  registry record pins no package env name; the capture was keyless).
  When set, `Authorization: Bearer <value>` is sent on every upstream
  request (header name pinned by the registry record's remote
  declaration; Bearer form is a reconstruction). When unset, no key
  header is sent. Both branches are tested.
- Error rendering `billparse error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and extra
  fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) → notifications/initialized →
  tools/call, honouring `Mcp-Session-Id` when issued; plain-JSON and SSE
  replies are both parsed. The forwarding core takes an injectable fetch;
  tests stub the upstream — no live network calls in tests.

## Lockfile

- Route: **Route 3** — generated clean from birth in the build dir with
  no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/billparse`.
- Package entries: **128**.
- sha256: `e8c9c538cd73b46d71bd8a237d37bfbaaf26c5a2561fb7fc2003324d21d98d4b`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Turn invoice PDFs, scans and photos into checked
  spreadsheets and structured data." — **82 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/billparse:0.1.0`) carries **no** `version`
  field. Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/billparse"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/billparse` and
  its smoke test asserts the server name `billparse`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → real `dist/` produced (cli, forward, index, mcp,
   types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`; unknown subcommand → Usage on
   stderr, exit 2.
4. `npm test` → **59 tests, 59 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 4 tools
   in order, plus session handling/reuse, env override, key-header
   present/absent/blank branches, verbatim argument forwarding and result
   pass-through including upstream isError, SSE parsing, error rendering,
   MCP-layer validation, and CLI behaviour).
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/invoiceparserpro-tools-original.json --rebuild
   "stdio:node builds/billparse/dist/cli.js mcp" --out
   builds/billparse/parity-out` → **verdict PASS, parity 100.0**
   (4/4 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
