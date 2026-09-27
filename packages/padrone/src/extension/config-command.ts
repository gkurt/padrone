import type { StandardSchemaV1 } from '@standard-schema/spec';
import { coerceArgs, extractSchemaMetadata, getJsonSchema, isSensitiveField, REDACTED } from '../core/args.ts';
import { getGlobalArgs, resolveCommand } from '../core/commands.ts';
import { ActionError, ConfigError } from '../core/errors.ts';
import { formatIssueMessages } from '../core/validate.ts';
import type { AnyPadroneBuilder, AnyPadroneCommand, PadroneInterceptorFn, PadroneSchema } from '../types/index.ts';
import { removeJsoncValue, setJsoncValue } from '../util/jsonc.ts';
import { getRootCommand } from '../util/utils.ts';
import type { ConfigLayer, ConfigLoader, ConfigSearchOptions } from './config-loader.ts';
import {
  applyProfile,
  configFileExtension,
  findLocalConfigFile,
  findUserConfigFile,
  getPath,
  isConfigObject,
  isJsonConfigFile,
  isScriptConfigFile,
  loadConfigData,
  parseConfigText,
} from './config-loader.ts';
import { isLooseSchema, localOnlyInterceptor, passthroughSchema } from './utils.ts';

type ConfigData = Record<string, unknown>;
type Env = Record<string, string | undefined>;

/** How `padroneConfig()` finds and reads configs, shared by its interceptor and its `config` command. */
export type ConfigSource = {
  files: string[];
  schema?: StandardSchemaV1;
  /** A custom loader that replaces the built-in one. */
  loadConfig?: ConfigLoader;
  profileFlag?: string;
  /** Whether keys naming subcommands are per-command sections (`sections`). */
  sections: boolean;
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

type OptionMatch = { schema: PadroneSchema; name: string; sensitive: boolean };

function isSensitiveOption(schema: PadroneSchema, meta: { fields?: any } | undefined, name: string): boolean {
  try {
    const fields = meta?.fields ?? {};
    return isSensitiveField(Object.hasOwn(fields, name) ? fields[name] : undefined, getJsonSchema(schema).properties?.[name]);
  } catch {
    return false;
  }
}

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
      if (name) matches.push({ schema, name, sensitive: isSensitiveOption(schema, meta, name) });
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

  // With sections, leading keys that name subcommands (`serve.port`) are the section of that command
  let command = target;
  let section: string[] = [];
  while (source.sections && section.length < path.length - 1) {
    const found = command.commands?.map(resolveCommand).find((c) => c.name === path[section.length] && c.name !== groupName);
    if (!found) break;
    command = found;
    section = path.slice(0, section.length + 1);
  }
  const rest = path.slice(section.length);
  const scoped = getPath(effective, section);
  const values = isConfigObject(scoped) ? scoped : {};

  const { matches, loose } = findOptions(command, rest[0]!, groupName);
  if (matches.length === 0) {
    if (!loose) throw new ActionError(`Unknown config key "${key}": no command has an option named "${rest[0]}"`);
    return { path, value: parseValue(raw, undefined, rest) };
  }
  const stored = [matches[0]!.name, ...rest.slice(1)];
  const value = parseValue(raw, matches[0]!.schema, stored);
  for (const { schema, name } of matches) {
    const optionPath = [name, ...rest.slice(1)];
    const issues = await validationIssues(schema, { [name]: getPath(setPath(values, optionPath, value), [name]) }, optionPath);
    if (issues.length) fail(issues);
  }
  return { path: [...section, ...stored], value };
}

// ── Files ────────────────────────────────────────────────────────────────

async function loadLayers(source: ConfigSource, command: AnyPadroneCommand, env: Env) {
  const { xdgAppName, search } = source.locate(command, env);
  const { data, layers } = await loadConfigData(source.loadConfig, source.files, xdgAppName, search);
  return { layers, data: data ?? {} };
}

type FileArgs = { local?: boolean; file?: string };

/** The file `--local` (the project config) or `--file <path>` picks, if either is given. */
async function chosenFile(source: ConfigSource, command: AnyPadroneCommand, env: Env, args: FileArgs, anyText = false) {
  if (args.local && args.file) throw new ActionError('Use --local or --file, not both');
  if (args.file) return (await import('node:path')).resolve(args.file);
  if (!args.local) return undefined;
  const parents = !!source.locate(command, env).search?.parents;
  const file = await findLocalConfigFile(source.files, parents, anyText ? (name) => !isScriptConfigFile(name) : undefined);
  if (!file) throw new ActionError(`No ${anyText ? '' : 'JSON '}file name in the config \`files\` to create in the current directory`);
  return file;
}

/** The user config file; one that doesn't exist yet gets the first name in `files` that `set` can write (or `edit`, any text). */
async function userFile(source: ConfigSource, command: AnyPadroneCommand, env: Env, anyText = false): Promise<string> {
  const appName = source.locate(command, env).xdgAppName ?? getRootCommand(command).name;
  const found = await findUserConfigFile(source.files, appName, env, anyText ? (file) => !isScriptConfigFile(file) : undefined);
  if (!found) throw new ActionError('Cannot locate the user config directory: set HOME or XDG_CONFIG_HOME');
  if (!found.file) throw new ActionError(`No ${anyText ? '' : 'JSON '}file name in the config \`files\` to create in ${found.dir}`);
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

async function readData(file: string): Promise<ConfigData> {
  const text = await readText(file);
  return text === undefined ? {} : parseFile(text, file);
}

/** Reads a config file for `set`/`unset`, which only change JSON files. */
async function readWritable(file: string, groupName: string): Promise<{ text?: string; data: ConfigData }> {
  if (!isJsonConfigFile(file))
    throw new ActionError(`Cannot write ${file}: only JSON config files can be changed, use \`${groupName} edit\``);
  const text = await readText(file);
  return { text, data: text === undefined ? {} : parseFile(text, file) };
}

/**
 * The text of a JSON config file with `updated` data: the value at `path` changed in place, so comments and formatting
 * stay, or else the data rewritten as JSON.
 */
function updatedText(file: string, text: string | undefined, updated: ConfigData, path: readonly string[], value?: unknown): string {
  try {
    const edited = value === undefined ? removeJsoncValue(text ?? '', path) : setJsoncValue(text ?? '', path, value);
    if (edited !== undefined && JSON.stringify(parseFile(edited, file)) === JSON.stringify(updated)) return edited;
  } catch {}
  return `${JSON.stringify(updated, null, 2)}\n`;
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
  const fileFields = {
    local: { type: 'boolean', description: 'Use the project config file in the current directory' },
    file: { type: 'string', description: 'Use this config file' },
  } as const;
  const keyField = { key: { type: 'string', description: 'Config key, dotted for nested values (`db.host`)' } } as const;
  const keyArgs = passthroughSchema({ ...keyField, ...profileField, ...fileFields });

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

  /** The values in one file (`--local`, `--file`), inside `profiles.<name>` with `--profile`. */
  const fileValues = async (file: string, profile: string | undefined) => {
    const data = await readData(file);
    const values = profile ? getPath(data, ['profiles', profile]) : data;
    return { data: isConfigObject(values) ? values : {}, layers: [{ file, data }] as ConfigLayer[] | undefined, profile };
  };

  /** The file `set`/`unset`/`edit` change: `--local`, `--file`, else the user config file. */
  const fileToChange = async (command: AnyPadroneCommand, env: Env, args: FileArgs, anyText = false) =>
    (await chosenFile(source, targetOf(command), env, args, anyText)) ?? (await userFile(source, targetOf(command), env, anyText));

  /** The key path in the file: inside `profiles.<name>` with `--profile`. */
  const filePath = (path: string[], profile: string | undefined) => (profile ? ['profiles', profile, ...path] : path);

  /** The path `set` stores a key under: an alias or kebab-case name (`dry-run`) as its option name (`dryRun`). */
  const optionPath = (command: AnyPadroneCommand, path: string[]) => {
    const name = source.schema ? undefined : findOptions(targetOf(command), path[0]!, groupName).matches[0]?.name;
    return name ? [name, ...path.slice(1)] : path;
  };

  return builder.command(groupName, (group) =>
    group
      .configure({ description: 'Manage configuration', builtin: true })
      .intercept(disabledInterceptor)
      .intercept(localOnlyInterceptor())
      .command('get', (c) =>
        c
          .configure({ description: 'Print a config value' })
          .arguments(keyArgs, { positional: ['key'] })
          .async()
          .action(async (args, ctx) => {
            const path = splitKey(args.key, `${groupName} get <key>`);
            const env = ctx.runtime.env();
            const file = await chosenFile(source, targetOf(ctx.command), env, args);
            const profile = profileArg(args);
            const { data } = file ? await fileValues(file, profile) : await effective(ctx.command, env, profile);
            const value = getPath(data, path) ?? getPath(data, optionPath(ctx.command, path));
            if (value === undefined) throw new ActionError(`"${args.key}" is not set${file ? ` in ${file}` : ''}`);
            return value;
          }),
      )
      .command('set', (c) =>
        c
          .configure({ description: 'Set a value in the user config file', mutation: true })
          .arguments(
            passthroughSchema({ ...keyField, value: { type: 'string', description: 'The value' }, ...profileField, ...fileFields }),
            { positional: ['key', 'value'] },
          )
          .async()
          .action(async (args, ctx) => {
            const path = splitKey(args.key, `${groupName} set <key> <value>`);
            if (args.value === undefined) throw new ActionError(`Usage: ${groupName} set <key> <value>`);
            const env = ctx.runtime.env();
            const file = await fileToChange(ctx.command, env, args);
            const { text, data } = await readWritable(file, groupName);
            const profile = profileArg(args);
            const { data: current } = await effective(ctx.command, env, profile, true);
            const resolved = await resolveSetValue(source, targetOf(ctx.command), groupName, path, args.value, current);
            const stored = filePath(resolved.path, profile);
            await writeText(file, updatedText(file, text, setPath(data, stored, resolved.value), stored, resolved.value));
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
            const file = await fileToChange(ctx.command, ctx.runtime.env(), args);
            const profile = profileArg(args);
            const { text, data } = await readWritable(file, groupName);
            const stored = [filePath(path, profile), filePath(optionPath(ctx.command, path), profile)].find((p) => unsetPath(data, p));
            if (!stored) throw new ActionError(`"${args.key}" is not set${profile ? ` in profile "${profile}"` : ''} in ${file}`);
            await writeText(file, updatedText(file, text, unsetPath(data, stored)!, stored));
            return `Unset ${args.key}${profile ? ` in profile "${profile}"` : ''} (${file})`;
          }),
      )
      .command(['list', 'ls'], (c) =>
        c
          .configure({ description: 'List the config values and the files they come from' })
          .arguments(passthroughSchema({ ...profileField, ...fileFields }), {})
          .async()
          .action(async (args, ctx) => {
            const env = ctx.runtime.env();
            const file = await chosenFile(source, targetOf(ctx.command), env, args);
            const profileName = profileArg(args as Record<string, unknown>);
            const { data, layers, profile } = file ? await fileValues(file, profileName) : await effective(ctx.command, env, profileName);
            const entries = flatten(data);
            if (entries.length === 0) return 'No config values';
            // The last file that sets a value (inside the profile first) is where it comes from
            const sourceOf = (path: string[]) =>
              layers?.findLast((layer) => profile && getPath(layer.data, ['profiles', profile, ...path]) !== undefined)?.file ??
              layers?.findLast((layer) => getPath(layer.data, path) !== undefined)?.file;
            const target = targetOf(ctx.command);
            const sensitive = (key: string) =>
              source.schema
                ? isSensitiveOption(source.schema as PadroneSchema, undefined, key)
                : findOptions(target, key, groupName).matches.some((match) => match.sensitive);
            const lines = entries.map(
              ([path, value]) => [`${path.join('.')}=${sensitive(path[0]!) ? REDACTED : formatValue(value)}`, sourceOf(path)] as const,
            );
            const width = Math.max(...lines.map(([line]) => line.length)) + 2;
            const header = profile ? [`Profile: ${profile}`] : [];
            return [...header, ...lines.map(([line, file]) => (file ? `${line.padEnd(width)}${file}` : line))].join('\n');
          }),
      )
      .command('path', (c) =>
        c
          .configure({ description: 'Show the config files that are loaded and the one `set` writes' })
          .arguments(passthroughSchema(fileFields), {})
          .async()
          .action(async (args, ctx) => {
            const env = ctx.runtime.env();
            const target = targetOf(ctx.command);
            const chosen = await chosenFile(source, target, env, args, true);
            if (chosen) return chosen;
            const file = await userFile(source, target, env, true);
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
          .arguments(passthroughSchema(fileFields), {})
          .async()
          .action(async (args, ctx) => {
            const file = await fileToChange(ctx.command, ctx.runtime.env(), args, true);
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
