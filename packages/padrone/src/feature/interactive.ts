import type { StandardSchemaV1 } from '@standard-schema/spec';
import { coerceArgs, getJsonSchema, isSensitiveField, REDACTED } from '../core/args.ts';
import { getGlobalArgs } from '../core/commands.ts';
import { getNestedValue } from '../core/parse.ts';
import { hasInteractiveConfig } from '../core/results.ts';
import type { InteractivePromptConfig, ResolvedPadroneRuntime } from '../core/runtime.ts';
import type { AnyPadroneCommand, PadroneSchema } from '../types/index.ts';

/**
 * Auto-detect the prompt type for a field based on its JSON schema property definition.
 */
export function detectPromptConfig(
  name: string,
  propSchema: Record<string, any> | undefined,
  description?: string,
): InteractivePromptConfig {
  const message = description || propSchema?.description || name;

  if (!propSchema) return { name, message, type: 'input' };

  if (propSchema.type === 'boolean') {
    return { name, message, type: 'confirm', default: propSchema.default };
  }

  if (propSchema.enum) {
    return {
      name,
      message,
      type: 'select',
      choices: propSchema.enum.map((v: unknown) => ({ label: String(v), value: v })),
      default: propSchema.default,
    };
  }

  if (propSchema.type === 'array' && propSchema.items?.enum) {
    return {
      name,
      message,
      type: 'multiselect',
      choices: propSchema.items.enum.map((v: unknown) => ({ label: String(v), value: v })),
      default: propSchema.default,
    };
  }

  if (propSchema.format === 'password') {
    return { name, message, type: 'password', default: propSchema.default };
  }

  return { name, message, type: 'input', default: propSchema.default };
}

/** `data` with `value` at `path` (`['db', 'host']`), copying the objects on the way. */
function withValueAt(data: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return data;
  const inner = data[key];
  const child = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
  return { ...data, [key]: rest.length ? withValueAt(child, rest, value) : value };
}

type ObjectProperty = Record<string, any> & { properties: Record<string, any>; required?: string[] };

/** An object field with known keys, which is prompted key by key. */
const isObjectProperty = (prop: Record<string, any> | undefined): prop is ObjectProperty => prop?.type === 'object' && !!prop.properties;

/** A text answer can't fill a list of objects, or an object without known keys; validation reports such fields instead. */
const isPromptable = (prop: Record<string, any> | undefined) =>
  prop?.items?.type !== 'object' && (prop?.type !== 'object' || isObjectProperty(prop));

/**
 * A prompt answer as the field's value: choices map back to their values (prompts may answer with their labels
 * as strings), and text is coerced like CLI input (`'3'` → `3`, `'a, b'` → `['a', 'b']` for arrays).
 */
function answerValue(
  answer: unknown,
  path: string[],
  config: InteractivePromptConfig,
  propSchema: Record<string, any> | undefined,
  schema: PadroneSchema | undefined,
): unknown {
  const choices = config.choices;
  if (choices) {
    const toChoice = (v: unknown) => choices.find((c) => c.value === v || String(c.value) === String(v))?.value ?? v;
    return Array.isArray(answer) ? answer.map(toChoice) : toChoice(answer);
  }
  if (!schema) return answer;
  const value =
    typeof answer === 'string' && propSchema?.type === 'array'
      ? answer
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : answer;
  if (typeof value !== 'string' && !Array.isArray(value)) return value;
  return getNestedValue(coerceArgs(withValueAt({}, path, value), schema), path);
}

const issueKey = (segment: PropertyKey | StandardSchemaV1.PathSegment) => String(typeof segment === 'object' ? segment.key : segment);

/**
 * Prompt a single field (or an object's key, at `path`) and validate it against the schema that owns it.
 * Re-prompts with a warning until the user provides a valid value. A blank answer leaves an optional field unset,
 * takes the default, or is asked again for a required field.
 */
async function promptWithValidation(
  path: string[],
  config: InteractivePromptConfig,
  currentData: Record<string, unknown>,
  schema: PadroneSchema | undefined,
  runtime: ResolvedPadroneRuntime,
  propSchema: Record<string, any> | undefined,
  optional: boolean,
): Promise<unknown> {
  const name = path.join('.');
  let promptConfig = config;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const typed = await runtime.prompt!(promptConfig);
    const blank = typeof typed === 'string' && !typed.trim();
    if (blank && optional) return undefined;
    if (blank && config.default === undefined) {
      runtime.error(`A value for "${name}" is required`);
      continue;
    }
    const answer = blank ? config.default : typed;
    const value = answerValue(answer, path, config, propSchema, schema);

    if (!schema) return value;

    // Validate the full object with the new value to catch field-level issues
    const validated = await schema['~standard'].validate(withValueAt(currentData, path, value));

    if (!validated.issues) return value;

    // Only keep issues whose path starts with this field
    const fieldIssues = validated.issues.filter(
      (issue) => !!issue.path && issue.path.length >= path.length && path.every((key, i) => issueKey(issue.path![i]!) === key),
    );

    if (fieldIssues.length === 0) return value;

    // Warn the user and re-prompt with the invalid value as default
    const messages = fieldIssues.map((i) => i.message).join('; ');
    runtime.error(`Invalid value for "${name}": ${messages}`);
    // A masked prompt never gets the typed value back as its default
    promptConfig = config.type === 'password' ? config : { ...config, default: value };
  }
}

type InteractiveConfig = true | readonly string[] | undefined;

function readSchemaFields(schema: PadroneSchema | undefined): { properties: Record<string, any>; required: Set<string> } {
  if (!schema) return { properties: {}, required: new Set() };
  try {
    const jsonSchema = getJsonSchema(schema) as Record<string, any>;
    return {
      properties: jsonSchema.type === 'object' && jsonSchema.properties ? jsonSchema.properties : {},
      required: new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []),
    };
  } catch {
    return { properties: {}, required: new Set() };
  }
}

/**
 * Prompt for missing interactive fields.
 * Runs after env/config preprocessing and before schema validation.
 *
 * Covers the command's own fields and the global args it doesn't override. The command's `interactive: true`
 * includes required global fields; `.globalArgs(schema, { interactive })` prompts globals in every command of its subtree.
 *
 * When `force` is true, all configured interactive fields are prompted even if they already
 * have values. The current values are used as defaults in the prompts (except for sensitive fields).
 * `conditionallyRequired` lists fields that `requires`/`requiredIf`/`requiredUnless` made required: they're prompted like required ones.
 */
export async function promptInteractiveFields(
  data: Record<string, unknown>,
  command: AnyPadroneCommand,
  runtime: ResolvedPadroneRuntime,
  force?: boolean,
  conditionallyRequired: readonly string[] = [],
): Promise<Record<string, unknown>> {
  if (!runtime.prompt) return data;

  const meta = command.meta;
  const globalArgs = getGlobalArgs(command);
  if (!hasInteractiveConfig(meta) && !hasInteractiveConfig(globalArgs?.meta)) return data;

  const own = readSchemaFields(command.argsSchema);
  const globals = readSchemaFields(globalArgs?.schema);
  const globalOnly = new Set(Object.keys(globals.properties).filter((key) => !(key in own.properties)));

  // JSON schema properties for prompt type detection
  const jsonProperties: Record<string, any> = {
    ...Object.fromEntries([...globalOnly].map((key) => [key, globals.properties[key]])),
    ...own.properties,
  };
  const requiredGlobal = new Set([...globals.required, ...conditionallyRequired].filter((key) => globalOnly.has(key)));
  const requiredFields = new Set([...own.required, ...conditionallyRequired, ...requiredGlobal]);

  const fieldDescriptions: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(globalArgs?.meta?.fields ?? {})) {
    if (globalOnly.has(key) && value?.description) fieldDescriptions[key] = value.description;
  }
  for (const [key, value] of Object.entries(meta?.fields ?? {})) {
    if (value?.description) fieldDescriptions[key] = value.description;
  }
  const fieldMeta = (key: string) => (globalOnly.has(key) ? globalArgs?.meta?.fields : meta?.fields)?.[key];
  const sensitive = new Set(Object.keys(jsonProperties).filter((key) => isSensitiveField(fieldMeta(key), jsonProperties[key])));

  let result = { ...data };
  /** The keys of an object prompted: its required ones, or all when none is required. */
  const objectKeys = (prop: ObjectProperty) => {
    const keys = Object.keys(prop.properties);
    const required = keys.filter((key) => prop.required?.includes(key));
    return required.length ? required : keys;
  };
  /** Whether the value at `path` still needs a prompt: unset, or an object with keys left to prompt. */
  const needsPrompt = (path: string[], prop: Record<string, any> | undefined): boolean => {
    if (force) return true;
    const value = getNestedValue(result, path);
    if (!isObjectProperty(prop) || (value !== undefined && (typeof value !== 'object' || Array.isArray(value)))) return value === undefined;
    return objectKeys(prop).some((key) => needsPrompt([...path, key], prop.properties[key]));
  };
  const isMissing = (name: string) => needsPrompt([name], jsonProperties[name]);
  const schemaFor = (field: string) => (globalOnly.has(field) ? globalArgs?.schema : command.argsSchema);

  /** Fields a config selects: `true` → every candidate, a list → the named fields. Only missing ones unless forced. */
  const select = (config: InteractiveConfig, candidates: Iterable<string>) =>
    (config === true ? [...candidates] : Array.isArray(config) ? [...config] : []).filter(
      (name) => isMissing(name) && isPromptable(jsonProperties[name]),
    );

  const promptAt = async (field: string, path: string[], prop: Record<string, any> | undefined, optional: boolean) => {
    if (isObjectProperty(prop)) {
      // Key by key: `db.host`, `db.port`
      for (const key of objectKeys(prop)) {
        const sub = prop.properties[key];
        if (isPromptable(sub) && needsPrompt([...path, key], sub))
          await promptAt(field, [...path, key], sub, !prop.required?.includes(key));
      }
      return;
    }
    const name = path.join('.');
    const config = detectPromptConfig(name, prop, path.length === 1 ? fieldDescriptions[field] : undefined);
    const current = getNestedValue(result, path);
    if (sensitive.has(field)) {
      if (config.type === 'input') config.type = 'password';
      config.default = undefined;
    } else if (force && current !== undefined) {
      // When forced, use the current value as the default
      config.default = current;
    }
    const value = await promptWithValidation(path, config, result, schemaFor(field), runtime, prop, optional);
    if (value !== undefined || path.length === 1) result = withValueAt(result, path, value);
  };
  const promptField = (field: string) => promptAt(field, [field], jsonProperties[field], !requiredFields.has(field));

  // Prompt each required interactive field with per-field validation
  const fieldsToPrompt = new Set([
    ...select(meta?.interactive as InteractiveConfig, requiredFields),
    ...select(globalArgs?.meta?.interactive as InteractiveConfig, requiredGlobal),
  ]);
  for (const field of fieldsToPrompt) await promptField(field);

  // Determine optional interactive fields
  const optionalCandidates = Object.keys(jsonProperties).filter((name) => !requiredFields.has(name));
  const optionalFields = [
    ...new Set([
      ...select(meta?.optionalInteractive as InteractiveConfig, optionalCandidates),
      ...select(
        globalArgs?.meta?.optionalInteractive as InteractiveConfig,
        optionalCandidates.filter((name) => globalOnly.has(name)),
      ),
    ]),
  ].filter((name) => !fieldsToPrompt.has(name));

  // Show multiselect for optional fields, then prompt selected ones
  if (optionalFields.length > 0) {
    const selected = (await runtime.prompt({
      name: '_optionalFields',
      message: 'Would you also like to configure:',
      type: 'multiselect',
      choices: optionalFields.map((f) => {
        const label = fieldDescriptions[f] || jsonProperties[f]?.description || f;
        const currentValue = result[f];
        // When forced, show current value next to the label for fields that already have values
        const displayLabel =
          force && currentValue !== undefined ? `${label} (current: ${sensitive.has(f) ? REDACTED : currentValue})` : label;
        return { label: displayLabel, value: f };
      }),
    })) as string[];

    if (Array.isArray(selected)) {
      for (const field of selected) await promptField(field);
    }
  }

  return result;
}
