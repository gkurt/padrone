import { coerceArgs, getJsonSchema } from '../core/args.ts';
import { getGlobalArgs } from '../core/commands.ts';
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

/**
 * A prompt answer as the field's value: choices map back to their values (prompts may answer with their labels
 * as strings), and text is coerced like CLI input (`'3'` → `3`, `'a, b'` → `['a', 'b']` for arrays).
 */
function answerValue(
  answer: unknown,
  field: string,
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
  return coerceArgs({ [field]: value }, schema)[field];
}

/**
 * Prompt a single field and validate it against the schema that owns it.
 * Re-prompts with a warning until the user provides a valid value.
 */
async function promptWithValidation(
  field: string,
  config: InteractivePromptConfig,
  currentData: Record<string, unknown>,
  schema: PadroneSchema | undefined,
  runtime: ResolvedPadroneRuntime,
  propSchema: Record<string, any> | undefined,
): Promise<unknown> {
  let promptConfig = config;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = answerValue(await runtime.prompt!(promptConfig), field, config, propSchema, schema);

    if (!schema) return value;

    // Validate the full object with the new value to catch field-level issues
    const testData = { ...currentData, [field]: value };
    const validated = await schema['~standard'].validate(testData);

    if (!validated.issues) return value;

    // Only keep issues whose path starts with this field
    const fieldIssues = validated.issues.filter((issue) => {
      const rootKey = issue.path?.[0];
      const key = typeof rootKey === 'object' ? rootKey.key : rootKey;
      return key !== undefined && String(key) === field;
    });

    if (fieldIssues.length === 0) return value;

    // Warn the user and re-prompt with the invalid value as default
    const messages = fieldIssues.map((i) => i.message).join('; ');
    runtime.error(`Invalid value for "${field}": ${messages}`);
    promptConfig = { ...config, default: value };
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
 * have values. The current values are used as defaults in the prompts.
 */
export async function promptInteractiveFields(
  data: Record<string, unknown>,
  command: AnyPadroneCommand,
  runtime: ResolvedPadroneRuntime,
  force?: boolean,
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
  const requiredGlobal = new Set([...globals.required].filter((key) => globalOnly.has(key)));
  const requiredFields = new Set([...own.required, ...requiredGlobal]);

  const fieldDescriptions: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(globalArgs?.meta?.fields ?? {})) {
    if (globalOnly.has(key) && value?.description) fieldDescriptions[key] = value.description;
  }
  for (const [key, value] of Object.entries(meta?.fields ?? {})) {
    if (value?.description) fieldDescriptions[key] = value.description;
  }

  const result = { ...data };
  const isMissing = (name: string) => force || result[name] === undefined;
  const schemaFor = (field: string) => (globalOnly.has(field) ? globalArgs?.schema : command.argsSchema);

  /** Fields a config selects: `true` → every candidate, a list → the named fields. Only missing ones unless forced. */
  const select = (config: InteractiveConfig, candidates: Iterable<string>) =>
    (config === true ? [...candidates] : Array.isArray(config) ? [...config] : []).filter(isMissing);

  const promptField = async (field: string) => {
    const config = detectPromptConfig(field, jsonProperties[field], fieldDescriptions[field]);
    // When forced, use the current value as the default
    if (force && result[field] !== undefined) config.default = result[field];
    result[field] = await promptWithValidation(field, config, result, schemaFor(field), runtime, jsonProperties[field]);
  };

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
        const displayLabel = force && currentValue !== undefined ? `${label} (current: ${currentValue})` : label;
        return { label: displayLabel, value: f };
      }),
    })) as string[];

    if (Array.isArray(selected)) {
      for (const field of selected) await promptField(field);
    }
  }

  return result;
}
