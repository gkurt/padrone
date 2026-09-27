# Padrone Pizza

`pizza` is a small pizzeria CLI that uses as many Padrone features as it can. It runs in the terminal playground on the [Padrone website](https://gkurt.com/padrone/), and in a real terminal:

```bash
cd examples/pizza-example
bun start menu
bun start order margherita --size large -t basil -ppp --pickup
```

Some things to try:

```bash
pizza --help                                  # generated help, grouped commands, global options, env vars
pizza order                                   # interactive prompts for missing fields
pizza order funghi --party -n                 # implies (size/quantity) and a dry run with a price breakdown
pizza order diavola --extra-cheese --pickup   # deprecated option warning
pizza menu --veggie --spicy                   # conflicting options
pizza menu --json --jq '.[].id'               # JSON output filtered with jq
pizza orders track 2                          # live task list; Ctrl+C cancels it
pizza admin restock                           # progress bar with elapsed time and ETA
echo "Great crust" | pizza review 1 -r 5      # a field read from stdin
pizza chef ask how is the dough made?         # streamed output from an async generator
pizza redeem PADRONE                          # async validation
pizza ordr                                    # "did you mean", with an offer to run it
pizza repl                                    # the built-in REPL
```

## Where each feature lives

| Feature | Where |
| --- | --- |
| Program config, help `after` text, version | `createPizza()` in [`src/pizza.ts`](src/pizza.ts) |
| Typed context (`.context<T>()`) passed to `cli()` | `src/pizza.ts`, [`src/cli.ts`](src/cli.ts) |
| Global args (`--store`) | `.globalArgs()` in `src/pizza.ts` |
| Positionals, variadic positionals, enums, arrays, defaults | `order`, `chef ask`, `admin restock` |
| Short flags, aliases, custom negatives (`--pickup`), counts (`-ppp`) | `order` |
| Field rules: `conflicts`, `implies`, `atLeastOne` | `menu`, `order`, `review` |
| Deprecated options and commands, hidden commands | `order --extra-cheese`, `deliver`, `pineapple` |
| Interactive prompts (`interactive`, `optionalInteractive`) | `order`, `chef ask` |
| Async validation (`.async()` + async refine) | `redeem` |
| Mutation commands + `padroneConfirm()` (`--yes`) | `order`, `orders cancel` |
| Dry runs (`.dryRun()`, `--dry-run`/`-n`) | `order`, `orders cancel` |
| Streaming results (async generators) and stdin streams | [`src/chef.ts`](src/chef.ts) |
| `stdin` into a field | `review` |
| Progress spinner, bar, ETA, task lists, cancellation via `ctx.signal` | `order`, [`src/orders.ts`](src/orders.ts), [`src/admin.ts`](src/admin.ts) |
| Declarative table/kv/tree output | `menu`, `orders list`, `orders show`, `admin stats` |
| Interceptors with `.requires<T>()`/`.provides<T>()` and cross-phase state | [`src/interceptors.ts`](src/interceptors.ts) |
| Commands in their own modules (`defineCommand().requires<T>()`) | `src/orders.ts` |
| A custom extension | `chef` in `src/chef.ts` |
| Program composition (`.mount()` with a context mapping) | `admin` in `src/admin.ts` |
| `ActionError` with suggestions | `src/orders.ts`, `review` |
| `ctx.runtime.open()` and `ctx.runtime.editor()` | `docs`, `feedback` |
| Extensions: logger, timing, JSON/jq, env (`PIZZA_*`), config file, completion | `createPizza()` |
| Built-ins: help (`pickSubcommand`), suggestions (`run: 'prompt'`), version, REPL, color, signals | `createPizza()` |
| Testing with `padrone/test` | [`tests/pizza.test.ts`](tests/pizza.test.ts) |

## The website terminal

The playground on the website (`docs/src/components/terminal/`) runs this program in the browser with a custom `PadroneRuntime`: output goes to a [ghostty-web](https://github.com/coder/ghostty-web) terminal, prompts are drawn with ANSI, Ctrl+C is delivered through `runtime.onSignal`, `pizza.config.json` comes from an in-memory file system through `padroneConfig({ loadConfig })`, and tab completion calls the program's own `__complete` command, as the scripts from `pizza completion` do.
