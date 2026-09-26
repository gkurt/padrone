import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineInterceptor } from '../core/interceptors.ts';
import { hasInteractiveConfig, thenMaybe } from '../core/results.ts';
import { buildCommandArgs, checkUnknownArgs } from '../core/validate.ts';
import { promptInteractiveFields } from '../feature/interactive.ts';
import type { AnyPadroneBuilder, CommandTypesBase, InterceptorValidateContext, InterceptorValidateResult } from '../types/index.ts';

// ── Interceptor ─────────────────────────────────────────────────────────

const interactiveInterceptor = defineInterceptor(
  { id: 'padrone:interactive', name: 'padrone:interactive', order: -999, options: { interactive: 'flag', i: 'flag' } },
  () => ({
    validate(ctx: InterceptorValidateContext, next) {
      // Extract --interactive / -i flags from rawArgs
      let flagInteractive: boolean | undefined;
      if (hasInteractiveConfig(ctx.command.meta)) {
        if (ctx.rawArgs.interactive !== undefined) {
          flagInteractive = ctx.rawArgs.interactive !== false && ctx.rawArgs.interactive !== 'false';
          delete ctx.rawArgs.interactive;
        }
        if (ctx.rawArgs.i !== undefined) {
          flagInteractive = ctx.rawArgs.i !== false && ctx.rawArgs.i !== 'false';
          delete ctx.rawArgs.i;
        }
      }

      // Resolve effective interactivity
      const { runtime, command } = ctx;
      const runtimeDefault: boolean | undefined =
        runtime.interactive === 'forced' ? true : runtime.interactive === 'disabled' ? false : undefined;
      const effectiveInteractive: boolean | undefined = flagInteractive ?? ctx.evalInteractive ?? runtimeDefault;
      const commandUsesStdin = !!command.meta?.stdin;
      const stdinIsPiped = commandUsesStdin && (runtime.stdin ? !runtime.stdin.isTTY : runtime.terminal?.isTTY !== true);
      const interactivitySuppressed =
        runtime.interactive === 'unsupported' || effectiveInteractive === false || (stdinIsPiped && effectiveInteractive !== true);
      const forceInteractive = !interactivitySuppressed && effectiveInteractive === true;

      const willPrompt = !interactivitySuppressed && runtime.prompt && hasInteractiveConfig(command.meta);
      if (!willPrompt) return next();

      // Preprocess args to determine what's missing
      const { args: preprocessedArgs, issues: positionalIssues } = buildCommandArgs(command, ctx.rawArgs, ctx.positionalArgs);
      if (positionalIssues) return { args: undefined, argsResult: { issues: positionalIssues } } as any;

      // Check for unknown args before prompting
      const unknowns = checkUnknownArgs(command, preprocessedArgs);
      if (unknowns.length > 0) {
        const issues: StandardSchemaV1.Issue[] = unknowns.map(({ key }) => ({
          path: [key],
          message: `Unknown option: "${key}"`,
        }));
        return { args: undefined, argsResult: { issues } } as any;
      }

      // Early-validate provided fields — fail fast on user-supplied errors before prompting
      const earlyValidateAndPrompt = (): InterceptorValidateResult | Promise<InterceptorValidateResult> => {
        if (command.argsSchema) {
          const providedKeys = new Set(Object.keys(preprocessedArgs).filter((k) => preprocessedArgs[k] !== undefined));
          const earlyCheck = command.argsSchema['~standard'].validate(preprocessedArgs);

          const checkForProvidedFieldErrors = (result: StandardSchemaV1.Result<unknown>): InterceptorValidateResult | undefined => {
            if (!result.issues) return undefined;
            const providedFieldIssues = result.issues.filter((issue: StandardSchemaV1.Issue) => {
              const rootKey = issue.path?.[0];
              return rootKey !== undefined && providedKeys.has(String(rootKey));
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
        const afterInteractive = promptInteractiveFields(preprocessedArgs, command, runtime, forceInteractive || undefined);

        return thenMaybe(afterInteractive, (filledArgs) => {
          // Pass preprocessed+prompted args downstream with empty positionalArgs (already mapped)
          return next({ rawArgs: filledArgs, positionalArgs: [] });
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
