# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted InvoiceParserPro MCP server. The four captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `invoice_to_excel`, `check_invoice`, `extract_invoice_data` and `get_result`. The three readers take the caller's own invoice as an https link, base64 bytes or a client-attached file; `get_result` fetches earlier outputs by `job_id` without submitting another document. No tool in this surface buys, subscribes, checks out or mints a key.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `billparse error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `INVOICEPARSERPRO_MCP_URL`; when `INVOICEPARSERPRO_API_KEY` is set it is sent as an `Authorization: Bearer` header on every upstream request.
