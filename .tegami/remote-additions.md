---
packages:
  padrone: minor
---

## Remote caller improvements

- `.configure({ needsApproval })` is typed: a boolean, or a function of the command's validated args.
- New `.configure({ outputSchema })`: advertised as the MCP tool's `outputSchema` and documented as the OpenAPI `result`.
- MCP returns object results as `structuredContent` as well as text.
- The MCP HTTP server rejects requests from origins other than loopback ones or the `cors` origin (403), guarding against DNS rebinding.
- Ending an MCP session with `DELETE` aborts its tool calls in flight.
- Serve responses include what the command wrote to stderr, as `stderr`.
- Serve rejects `sensitive` fields in GET query strings and leaves them out of the OpenAPI GET parameters.
- Tracing names spans `<caller> <command>` (such as `serve deploy`), uses a server span kind for serve and MCP, and sets the span status message from the error.
