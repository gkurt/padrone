import type { StandardSchemaV1 } from '@standard-schema/spec';
import { getGlobalArgs } from '../core/commands.ts';
import { resolveStdinAlways } from '../core/default-runtime.ts';
import { defineInterceptor } from '../core/interceptors.ts';
import { getNestedValue } from '../core/parse.ts';
import { thenMaybe, usesInteractive } from '../core/results.ts';
import {
  buildCommandArgs,
  checkUnknownArgs,
  getInterceptorOptionNames,
  getKnownOptionNames,
  unknownOptionMessage,
  validateCommandArgs,
} from '../core/validate.ts';
import { promptInteractiveFields } from '../feature/interactive.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext, InterceptorValidateResult } from '../types/index.ts';
import { frameworkFlags } from './utils.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const interactiveInterceptor = defineInterceptor(
  { id: 'padrone:interactive', name: 'padrone:interactive', order: -999, options: { interactive: 'flag', i: 'flag' } },
  () => ({
    validate(ctx: InterceptorValidateContext, next) {
      // Extract --interactive / -i flags from rawArgs; on a command with nothing to prompt for they're a no-op
      let flagInteractive: boolean | undefined;
      const flags = frameworkFlags(ctx.rawArgs, ctx.command);
      for (const key of ['interactive', 'i']) {
        const value = flags.flag(key);
        if (value !== undefined) flagInteractive = value;
      }
      flags.delete('interactive', 'i');
      // Inner interceptors (e.g. confirm) see the flag as `ctx.interactive`
      const proceed = (overrides?: Record<string, unknown>) =>
        next(flagInteractive === undefined ? overrides : { ...overrides, interactive: flagInteractive });

      // Resolve effective interactivity
      const { runtime, command } = ctx;
      const runtimeDefault: boolean | undefined =
        runtime.interactive === 'forced' ? true : runtime.interactive === 'disabled' ? false : undefined;
      const effectiveInteractive: boolean | undefined = flagInteractive ?? ctx.evalInteractive ?? runtimeDefault;
      const commandUsesStdin = !!command.meta?.stdin;
      const stdinIsPiped = commandUsesStdin && !resolveStdinAlways(runtime).isTTY;
      const interactivitySuppressed =
        runtime.interactive === 'unsupported' || effectiveInteractive === false || (stdinIsPiped && effectiveInteractive !== true);
      const forceInteractive = !interactivitySuppressed && effectiveInteractive === true;

      const willPrompt = !interactivitySuppressed && runtime.prompt && usesInteractive(command);
      if (!willPrompt) return proceed();

      // Preprocess args to determine what's missing
      const { args: preprocessedArgs, issues: argIssues, missing } = buildCommandArgs(command, ctx.rawArgs, ctx.positionalArgs);
      // Options made required by `requires`/`requiredIf`/`requiredUnless` may still be prompted; validation reports the rest
      const blocking = argIssues?.filter((issue) => !(issue.path?.length === 1 && missing?.includes(String(issue.path[0]))));
      if (blocking?.length) return { args: undefined, argsResult: { issues: blocking } } as any;

      // The early checks below skip options declared by interceptors: inner ones (e.g. confirm's `--yes`)
      // haven't read theirs yet, and still get them through the args passed on
      const interceptorOptions = getInterceptorOptionNames(command);
      const known = new Set(getKnownOptionNames(command));
      const ownArgs = Object.fromEntries(
        Object.entries(preprocessedArgs).filter(([key]) => known.has(key) || !interceptorOptions.has(key)),
      );

      // Check for unknown args before prompting
      const unknowns = checkUnknownArgs(command, ownArgs);
      if (unknowns.length > 0) {
        const issues: StandardSchemaV1.Issue[] = unknowns.map(({ key }) => ({ path: [key], message: unknownOptionMessage(key) }));
        return { args: undefined, argsResult: { issues } } as any;
      }

      // Early-validate provided fields — fail fast on user-supplied errors before prompting
      const earlyValidateAndPrompt = (): InterceptorValidateResult | Promise<InterceptorValidateResult> => {
        if (command.argsSchema || getGlobalArgs(command)) {
          const providedKeys = new Set(Object.keys(ownArgs).filter((k) => ownArgs[k] !== undefined));
          // Validates the command's own args and the global args it doesn't override
          const earlyCheck = validateCommandArgs(command, ownArgs);

          const checkForProvidedFieldErrors = (result: {
            argsResult?: StandardSchemaV1.Result<unknown>;
          }): InterceptorValidateResult | undefined => {
            if (!result.argsResult?.issues) return undefined;
            // Issues about a provided value; a key missing from a provided object (`--db.host h` without `db.port`) can still be prompted
            const providedFieldIssues = result.argsResult.issues.filter((issue: StandardSchemaV1.Issue) => {
              const rootKey = issue.path?.[0];
              if (rootKey === undefined || !providedKeys.has(String(rootKey))) return false;
              const path = issue.path!.map((segment) => String(typeof segment === 'object' ? segment.key : segment));
              return getNestedValue(ownArgs, path) !== undefined;
            });
            if (providedFieldIssues.length > 0) return { args: undefined, argsResult: { issues: providedFieldIssues } as any };
            return undefined;
          };

          const earlyResult = thenMaybe(earlyCheck, (result) => checkForProvidedFieldErrors(result) ?? undefined);
          if (earlyResult instanceof Promise) {
            return earlyResult.then((err) => (err ? err : doPrompt()));
          }
          if (earlyResult) return earlyResult;
        }

        return doPrompt();
      };

      // Prompt for missing fields, then pass filled args to downstream validation via next()
      const doPrompt = (): InterceptorValidateResult | Promise<InterceptorValidateResult> => {
        const afterInteractive = promptInteractiveFields(preprocessedArgs, command, runtime, forceInteractive || undefined, missing);

        return thenMaybe(afterInteractive, (filledArgs) => {
          // Pass preprocessed+prompted args downstream with empty positionalArgs (already mapped)
          return proceed({ rawArgs: filledArgs, positionalArgs: [] });
        });
      };

      return earlyValidateAndPrompt();
    },
  }),
);

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Extension that handles interactive prompting for missing arguments.
 * Extracts `--interactive` / `-i` flags, resolves effective interactivity,
 * and prompts for missing fields before passing filled args to validation.
 *
 * Usage:
 * ```ts
 * createPadrone('my-cli').extend(padroneInteractive())
 * ```
 */
export function padroneInteractive(): <T extends CommandTypesBase>(builder: T) => T {
  return ((builder: AnyPadroneBuilder) => builder.intercept(interactiveInterceptor)) as any;
}
