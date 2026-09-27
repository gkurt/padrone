import type { StandardSchemaV1 } from '@standard-schema/spec';
import { coerceArgs, extractSchemaMetadata, getJsonSchema } from '../core/args.ts';
import { getGlobalArgs, resolveCommand } from '../core/commands.ts';
import { ActionError, ConfigError } from '../core/errors.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, PadroneInterceptorFn, PadroneSchema } from '../types/index.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ConfigLayer, ConfigSearchOptions } from './config-loader.ts';
import {
  applyProfile,
  configFileExtension,
  deepMerge,
  findUserConfigFile,
  isConfigObject,
  isJsonConfigFile,
  isScriptConfigFile,
  loadConfigLayers,
  parseConfigText,
} from './config-loader.ts';
import { isLooseSchema, passthroughSchema } from './utils.ts';

type ConfigData = Record<string, unknown>;
type Env = Record<string, string | undefined>;

/** How `padroneConfig()` finds and reads configs, shared by its interceptor and its `config` command. */
export type ConfigSource = {
  files: string[];
  schema?: StandardSchemaV1;
  /** A custom loader that replaces the built-in one. */
  loadConfig?: (files: string | string[], xdgAppName?: string, search?: ConfigSearchOptions) => unknown;
  profileFlag?: string;
  profileEnv: (command: AnyPadroneCommand) => string;
  locate: (command: AnyPadroneCommand, env: Env) => { xdgAppName?: string; search?: ConfigSearchOptions };
};

// ── Keys and values ──────────────────────────────────────────────────────

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function splitKey(key: string | undefined, usage: string): string[] {
  if (!key) throw new ActionError(`Usage: ${usage}`);
  const path = key.split('.');
  if (path.some((segment) => !segment || UNSAFE_KEYS.has(segment))) throw new ActionError(`Invalid config key "${key}"`);
  return path;
}

function getPath(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (isConfigObject(value) && Object.hasOwn(value, key) ? value[key] : undefined), data);
}

function setPath(data: ConfigData, [head, ...rest]: readonly string[], value: unknown): ConfigData {
  const current = data[head!];
  return { ...data, [head!]: rest.length ? setPath(isConfigObject(current) ? current : {}, rest, value) : value };
}

/** `data` without the value at `path` (and objects left empty by removing it), or `undefined` when it isn't set. */
function unsetPath(data: ConfigData, [head, ...rest]: readonly string[]): ConfigData | undefined {
  if (!Object.hasOwn(data, head!)) return undefined;
  const { [head!]: current, ...others } = data;
  if (rest.length === 0) return others;
  const updated = isConfigObject(current) ? unsetPath(current, rest) : undefined;
  if (!updated) return undefined;
  return Object.keys(updated).length > 0 ? { ...others, [head!]: updated } : others;
}

function flatten(data: ConfigData, prefix: string[] = []): [string[], unknown][] {
  return Object.entries(data).flatMap(([key, value]): [string[], unknown][] =>
    isConfigObject(value) && Object.keys(value).length > 0 ? flatten(value, [...prefix, key]) : [[[...prefix, key], value]],
  );
}

const formatValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** Whether one path is a prefix of the other, so an issue at `issuePath` concerns the value at `path`. */
function concerns(issue: StandardSchemaV1.Issue, path: readonly string[]): boolean {
  const issuePath = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment));
  return issuePath.every((segment, i) => i >= path.length || segment === path[i]);
}

/** A typed value: JSON for `[...]` and `{...}`, otherwise coerced by the property's schema type (strings when unknown). */
function parseValue(raw: string, schema: PadroneSchema | undefined, path: readonly string[]): unknown {
  if (/^\s*[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  if (!schema) return raw;
  const nested = path.reduceRight<unknown>((value, key) => ({ [key]: value }), raw) as ConfigData;
  return getPath(coerceArgs(nested, schema), path);
}

// ── Schemas the key belongs to ───────────────────────────────────────────

type OptionMatch = { schema: PadroneSchema; name: string };

function optionName(schema: PadroneSchema, meta: { fields?: any; autoAlias?: boolean } | undefined, key: string): string | undefined {
  try {
    if (Object.hasOwn(getJsonSchema(schema).properties ?? {}, key)) return key;
    const { flags, aliases } = extractSchemaMetadata(schema, meta?.fields, meta?.autoAlias);
    return Object.hasOwn(aliases, key) ? aliases[key] : Object.hasOwn(flags, key) ? flags[key] : undefined;
  } catch {
    return undefined;
  }
}

/** The options named `key` (or an alias of it) on the command and its subcommands, and whether any of them takes unknown keys. */
function findOptions(target: AnyPadroneCommand, key: string, groupName: string) {
  const matches: OptionMatch[] = [];
  const seen = new Set<PadroneSchema>();
  let loose = false;
  const visit = (command: AnyPadroneCommand) => {
    const globals = getGlobalArgs(command);
    for (const [schema, meta] of [
      [command.argsSchema, command.meta],
      [globals?.schema, globals?.meta],
    ] as const) {
      if (!schema || seen.has(schema)) continue;
      seen.add(schema);
      loose ||= isLooseSchema(schema);
      const name = optionName(schema, meta, key);
      if (name) matches.push({ schema, name });
    }
    for (const child of command.commands ?? []) {
      const resolved = resolveCommand(child);
      if (!resolved.hidden && !(command === target && resolved.name === groupName)) visit(resolved);
    }
  };
  visit(target);
  return { matches, loose };
}

async function validationIssues(schema: StandardSchemaV1, value: unknown, path: readonly string[]) {
  const result = await schema['~standard'].validate(value);
  return (result.issues ?? []).filter((issue) => concerns(issue, path));
}

/**
 * The value `config set` stores and the key path it's stored under. With a config `schema`, the key and value must fit it.
 * Otherwise the key must name an option of the command or a subcommand (an alias maps to its option name), unless one of
 * their schemas takes unknown keys; the value is coerced and validated by each option's schema.
 */
async function resolveSetValue(
  source: ConfigSource,
  target: AnyPadroneCommand,
  groupName: string,
  path: string[],
  raw: string,
  effective: ConfigData,
) {
  const key = path.join('.');
  const fail = (issues: readonly StandardSchemaV1.Issue[]) => {
    throw new ActionError(`Invalid value for "${key}":\n${formatIssueMessages(issues)}`);
  };

  if (source.schema) {
    const schema = source.schema as PadroneSchema;
    const known = optionName(schema, undefined, path[0]!) === path[0];
    if (!known && !isLooseSchema(schema)) throw new ActionError(`Unknown config key "${key}"`);
    const value = parseValue(raw, known ? schema : undefined, path);
    const issues = await validationIssues(schema, setPath(effective, path, value), path);
    if (issues.length) fail(issues);
    return { path, value };
  }

  const { matches, loose } = findOptions(target, path[0]!, groupName);
  if (matches.length === 0) {
    if (!loose) throw new ActionError(`Unknown config key "${key}": no command has an option named "${path[0]}"`);
    return { path, value: parseValue(raw, undefined, path) };
  }
  const stored = [matches[0]!.name, ...path.slice(1)];
  const value = parseValue(raw, matches[0]!.schema, stored);
  for (const { schema, name } of matches) {
    const optionPath = [name, ...path.slice(1)];
    const issues = await validationIssues(schema, { [name]: getPath(setPath(effective, optionPath, value), [name]) }, optionPath);
    if (issues.length) fail(issues);
  }
  return { path: stored, value };
}

// ── Files ────────────────────────────────────────────────────────────────

async function loadLayers(source: ConfigSource, command: AnyPadroneCommand, env: Env) {
  const { xdgAppName, search } = source.locate(command, env);
  if (source.loadConfig) {
    const data = (await source.loadConfig(source.files, xdgAppName, search)) as ConfigData | undefined;
    return { data: data ?? {} };
  }
  const layers = await loadConfigLayers(source.files, xdgAppName, search);
  return { layers, data: layers.reduce<ConfigData>((acc, layer) => deepMerge(acc, layer.data), {}) };
}

async function userFile(source: ConfigSource, command: AnyPadroneCommand, env: Env): Promise<string> {
  const appName = source.locate(command, env).xdgAppName ?? getRootCommand(command).name;
  const found = await findUserConfigFile(source.files, appName, env);
  if (!found) throw new ActionError('Cannot locate the user config directory: set HOME or XDG_CONFIG_HOME');
  if (!found.file) throw new ActionError(`No JSON file name in the config \`files\` to create in ${found.dir}`);
  return found.file;
}

async function readText(file: string): Promise<string | undefined> {
  const fs = await import('node:fs');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
}

function parseFile(text: string, file: string): ConfigData {
  const data = parseConfigText(text, configFileExtension(file), file);
  if (!isConfigObject(data)) throw new ConfigError(`Invalid config file ${file}: must be an object`);
  return data;
}

async function writeText(file: string, text: string): Promise<void> {
  const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
}

/** Reads the user config file for `set`/`unset`, which rewrite it as JSON. */
async function readWritable(file: string, groupName: string): Promise<ConfigData> {
  if (!isJsonConfigFile(file))
    throw new ActionError(`Cannot write ${file}: only JSON config files can be changed, use \`${groupName} edit\``);
  const text = await readText(file);
  return text === undefined ? {} : parseFile(text, file);
}

// ── Command ──────────────────────────────────────────────────────────────

/** Adds the `config get|set|unset|list|path|edit` command group of `padroneConfig({ command })`. */
export function addConfigCommand(
  builder: AnyPadroneBuilder,
  groupName: string,
  source: ConfigSource,
  disabledInterceptor: PadroneInterceptorFn,
): AnyPadroneBuilder {
  const { profileFlag } = source;
  const profileField = profileFlag ? { [profileFlag]: { type: 'string', description: 'Config profile' } as const } : {};
  const keyField = { key: { type: 'string', description: 'Config key, dotted for nested values (`db.host`)' } } as const;
  const keyArgs = passthroughSchema({ ...keyField, ...profileField });

  /** The command `padroneConfig()` was applied to (the group's parent). */
  const targetOf = (command: AnyPadroneCommand) => command.parent?.parent ?? getRootCommand(command);
  const profileArg = (args: Record<string, unknown>) => {
    const profile = profileFlag ? (args[profileFlag] as string | undefined) : undefined;
    if (profile && UNSAFE_KEYS.has(profile)) throw new ActionError(`Invalid profile name "${profile}"`);
    return profile;
  };

  /** The values commands get: merged configs with the selected profile applied (`--profile`, the env variable, the `profile` key). */
  const effective = async (command: AnyPadroneCommand, env: Env, profile: string | undefined, create = false) => {
    const target = targetOf(command);
    const loaded = await loadLayers(source, target, env);
    if (!profileFlag) return { ...loaded, profile: undefined };
    const selected = profile || env[source.profileEnv(target)] || undefined;
    // `set --profile` may create the profile
    const exists = !selected || isConfigObject(getPath(loaded.data, ['profiles', selected]));
    const data = applyProfile(create && !exists ? setPath(loaded.data, ['profiles', selected!], {}) : loaded.data, selected);
    return { ...loaded, data, profile: selected ?? (typeof loaded.data.profile === 'string' ? loaded.data.profile : undefined) };
  };

  /** The key path in the user file: inside `profiles.<name>` with `--profile`. */
  const filePath = (path: string[], profile: string | undefined) => (profile ? ['profiles', profile, ...path] : path);

  return builder.command(groupName, (group) =>
    group
      .configure({ description: 'Manage configuration' })
      .intercept(disabledInterceptor)
      .command('get', (c) =>
        c
          .configure({ description: 'Print a config value' })
          .arguments(keyArgs, { positional: ['key'] })
          .async()
          .action(async (args, ctx) => {
            const path = splitKey(args.key, `${groupName} get <key>`);
            const { data } = await effective(ctx.command, ctx.runtime.env(), profileArg(args));
            const value = getPath(data, path);
            if (value === undefined) throw new ActionError(`"${args.key}" is not set`);
            return value;
          }),
      )
      .command('set', (c) =>
        c
          .configure({ description: 'Set a value in the user config file', mutation: true })
          .arguments(passthroughSchema({ ...keyField, value: { type: 'string', description: 'The value' }, ...profileField }), {
            positional: ['key', 'value'],
          })
          .async()
          .action(async (args, ctx) => {
            const path = splitKey(args.key, `${groupName} set <key> <value>`);
            if (args.value === undefined) throw new ActionError(`Usage: ${groupName} set <key> <value>`);
            const env = ctx.runtime.env();
            const file = await userFile(source, targetOf(ctx.command), env);
            const data = await readWritable(file, groupName);
            const profile = profileArg(args);
            const { data: current } = await effective(ctx.command, env, profile, true);
            const resolved = await resolveSetValue(source, targetOf(ctx.command), groupName, path, args.value, current);
            await writeText(file, `${JSON.stringify(setPath(data, filePath(resolved.path, profile), resolved.value), null, 2)}\n`);
            return `Set ${resolved.path.join('.')} = ${formatValue(resolved.value)}${profile ? ` in profile "${profile}"` : ''} (${file})`;
          }),
      )
      .command('unset', (c) =>
        c
          .configure({ description: 'Remove a value from the user config file', mutation: true })
          .arguments(keyArgs, { positional: ['key'] })
          .async()
          .action(async (args, ctx) => {
            const path = splitKey(args.key, `${groupName} unset <key>`);
            const file = await userFile(source, targetOf(ctx.command), ctx.runtime.env());
            const profile = profileArg(args);
            const updated = unsetPath(await readWritable(file, groupName), filePath(path, profile));
            if (!updated) throw new ActionError(`"${args.key}" is not set${profile ? ` in profile "${profile}"` : ''} in ${file}`);
            await writeText(file, `${JSON.stringify(updated, null, 2)}\n`);
            return `Unset ${args.key}${profile ? ` in profile "${profile}"` : ''} (${file})`;
          }),
      )
      .command(['list', 'ls'], (c) =>
        c
          .configure({ description: 'List the config values and the files they come from' })
          .arguments(passthroughSchema(profileField), {})
          .async()
          .action(async (args, ctx) => {
            const { data, layers, profile } = await effective(ctx.command, ctx.runtime.env(), profileArg(args as Record<string, unknown>));
            const entries = flatten(data);
            if (entries.length === 0) return 'No config values';
            // The last file that sets a value (inside the profile first) is where it comes from
            const sourceOf = (path: string[]) =>
              layers?.findLast((layer) => profile && getPath(layer.data, ['profiles', profile, ...path]) !== undefined)?.file ??
              layers?.findLast((layer) => getPath(layer.data, path) !== undefined)?.file;
            const lines = entries.map(([path, value]) => [`${path.join('.')}=${formatValue(value)}`, sourceOf(path)] as const);
            const width = Math.max(...lines.map(([line]) => line.length)) + 2;
            const header = profile ? [`Profile: ${profile}`] : [];
            return [...header, ...lines.map(([line, file]) => (file ? `${line.padEnd(width)}${file}` : line))].join('\n');
          }),
      )
      .command('path', (c) =>
        c
          .configure({ description: 'Show the config files that are loaded and the one `set` writes' })
          .async()
          .action(async (_args, ctx) => {
            const env = ctx.runtime.env();
            const target = targetOf(ctx.command);
            const file = await userFile(source, target, env);
            const { layers } = await loadLayers(source, target, env);
            const loaded = layers?.length
              ? [
                  'Loaded (lowest precedence first):',
                  ...layers.map((layer: ConfigLayer) => `  ${layer.file}${layer.key ? ` ("${layer.key}")` : ''}`),
                ]
              : layers
                ? ['No config files found']
                : [];
            return [`User config: ${file}`, ...loaded].join('\n');
          }),
      )
      .command('edit', (c) =>
        c
          .configure({ description: 'Open the user config file in your editor', mutation: true })
          .async()
          .action(async (_args, ctx) => {
            const file = await userFile(source, targetOf(ctx.command), ctx.runtime.env());
            if (isScriptConfigFile(file)) throw new ActionError(`Cannot edit ${file}: it's a script, open it in your editor`);
            const json = isJsonConfigFile(file);
            const text = (await readText(file)) ?? (json ? '{\n}\n' : '');
            const extension = configFileExtension(file);
            const edited = await ctx.runtime.editor(text, { extension: json && extension !== '.jsonc' ? '.json' : extension });
            if (edited === text) return 'No changes';
            try {
              parseFile(edited, file);
            } catch (err) {
              throw new ActionError(`Not saved: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }
            await writeText(file, edited);
            return `Saved ${file}`;
          }),
      ),
  );
}
