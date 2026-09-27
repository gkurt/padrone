import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createFileEmitter, template } from 'padrone/codegen';
import * as z from 'zod/v4';
import type { PadroneActionContext } from '../types/index.ts';

export const initSchema = z.object({
  name: z.string().optional().describe('Project name (defaults to directory name)'),
  description: z.string().optional().describe('Project description'),
  version: z.string().optional().default('0.1.0').describe('Initial version'),
  dir: z.string().optional().describe('Target directory (defaults to current directory)'),
});

type InitArgs = z.infer<typeof initSchema>;

const packageJsonTemplate = template(`{
  "name": {{name}},
  "version": {{version}},
  "private": true,
  "type": "module",
  "module": "src/index.ts",
  "bin": "src/index.ts",
  "scripts": {
    "start": "bun src/index.ts",
    "dev": "bun --watch src/index.ts",
    "link": "padrone link",
    "unlink": "padrone unlink"
  },
  "dependencies": {
    "padrone": "^{{padroneVersion}}",
    "zod": "^4.0.0"
  }
}
`);

const tsconfigTemplate = template(`{
  "compilerOptions": {
    "target": "ESNext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`);

const programTemplate = template(`import { createPadrone } from 'padrone'
import * as z from 'zod/v4'

const program = createPadrone({{name}})
  .configure({
    version: {{version}},
    description: {{description}},
  })
  .command('hello', (cmd) => cmd
    .configure({ description: 'Say hello' })
    .arguments(z.object({
      name: z.string().default('world').describe('Name to greet'),
    }), {
      positional: ['name'],
    })
    .action((args) => {
      return \`Hello, \${args.name}!\`
    })
  )

if (import.meta.main) {
  try {
    const cliRes = await program.cli();
    await cliRes.result;
  } catch (error) {
    console.error('Error running program:', error);
    process.exit(1);
  }
}

export default program;
export { program };
`);

export async function runInit(args: InitArgs, ctx: PadroneActionContext) {
  const { output, error } = ctx.runtime;
  const dir = resolve(args.dir || '.');
  const name = args.name || basename(dir);
  const description = args.description || `${name} CLI`;
  const version = args.version || '0.1.0';

  if (existsSync(resolve(dir, 'package.json'))) {
    error(`A package.json already exists in ${dir}. Aborting.`);
    return;
  }

  let padroneVersion = '1.0.0';
  try {
    const pkg = await import('padrone/package.json', { with: { type: 'json' } });
    padroneVersion = (pkg.default as any).version || padroneVersion;
  } catch {
    // Use fallback version
  }

  // Quoted, so names and descriptions with quotes stay valid JSON and TypeScript
  const data = { name: JSON.stringify(name), description: JSON.stringify(description), version: JSON.stringify(version), padroneVersion };

  const emitter = createFileEmitter({ outDir: dir });

  emitter.addFile('package.json', packageJsonTemplate(data));
  emitter.addFile('tsconfig.json', tsconfigTemplate(data));
  emitter.addFile('src/index.ts', programTemplate(data));

  const result = await emitter.emit();

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      error(`Failed to write ${err.file}: ${err.error.message}`);
    }
    return;
  }

  output(`Created ${name} CLI project in ${dir}`);
  output('');
  output('Files written:');
  for (const file of result.written) {
    output(`  ${file}`);
  }
  output('');
  output('Next steps:');
  if (dir !== process.cwd()) {
    output(`  cd ${dir}`);
  }
  output('  bun install');
  output('  bun update');
  output('  bun run dev');
}
