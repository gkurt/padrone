---
packages:
  padrone: minor
---

## Help topics, interceptor callers and custom events

- `builtins: { help: { topics: { environment: { title, description, content } } } }` (or `padroneHelp({ topics })`) adds help topics: `app help environment` prints the topic (through the pager when it's on; `{ topic, title, content }` under JSON output). The program's help lists them under "Additional help topics", `help <typo>` suggests them, completion offers them after `help`, and Markdown docs get a page per topic. A command of the same name wins.
- Interceptor meta `callers` runs an interceptor only for the listed callers (`LOCAL_CALLERS` and `REMOTE_CALLERS` are exported).
- Custom events between extensions: `defineEvent<T>(id)`, handled with `interceptor.on(event, handler)` and emitted with `ctx.emit(event, payload)` from actions and interceptors (or `program.emit()` outside an execution). Handlers run in interceptor order, and `emit()` resolves once they have.
- Function options in `createPadrone(name, { builtins })` are now contextually typed.
