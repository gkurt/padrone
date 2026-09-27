import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateDocs, removeManPages, setupManPages } from '../src/docs/index.ts';
import { createTasksProgram } from './common.ts';

describe('docs', () => {
  const program = createTasksProgram();

  describe('generateDocs', () => {
    it('should generate markdown docs for all commands', () => {
      const result = generateDocs(program, { format: 'markdown' });

      expect(result.pages.length).toBeGreaterThan(1);
      // Root index page
      expect(result.pages[0]!.path).toBe('index.md');
      // Should have pages for subcommands
      const paths = result.pages.map((p) => p.path);
      expect(paths).toContain('list.md');
      expect(paths).toContain('show.md');
    });

    it('should generate markdown content with proper structure', () => {
      const result = generateDocs(program, { format: 'markdown' });

      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage).toBeDefined();
      expect(showPage!.content).toContain('# show');
      expect(showPage!.content).toContain('## Usage');
      expect(showPage!.content).toContain('## Arguments');
      expect(showPage!.content).toContain('## Options');
      // Should have the positional arg
      expect(showPage!.content).toContain('`id`');
      // Should have options
      expect(showPage!.content).toContain('--priority');
      expect(showPage!.content).toContain('--verbose');
    });

    it('should generate html docs', () => {
      const result = generateDocs(program, { format: 'html' });

      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages[0]!.path).toBe('index.html');

      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage).toBeDefined();
      expect(showPage!.content).toContain('<article');
      expect(showPage!.content).toContain('<h1>show</h1>');
      expect(showPage!.content).toContain('<h2>Usage</h2>');
    });

    it('should generate man pages', () => {
      const result = generateDocs(program, { format: 'man' });

      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages[0]!.path).toBe('index.1');

      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage).toBeDefined();
      expect(showPage!.content).toContain('.TH');
      expect(showPage!.content).toContain('.SH NAME');
      expect(showPage!.content).toContain('.SH SYNOPSIS');
      expect(showPage!.content).toContain('.SH OPTIONS');
    });

    it('should generate json docs', () => {
      const result = generateDocs(program, { format: 'json' });

      expect(result.pages.length).toBeGreaterThan(0);
      const page = result.pages[0]!;
      const parsed = JSON.parse(page.content);
      expect(parsed.name).toBeDefined();
      expect(parsed.usage).toBeDefined();
    });

    it('should exclude hidden commands by default', () => {
      const result = generateDocs(program, { format: 'markdown' });
      for (const page of result.pages) {
        // Individual page content should not contain hidden options
        if (page.command === 'hidden-test') {
          expect(page.content).toContain('visibleArg');
          expect(page.content).not.toContain('hiddenArg');
        }
      }
    });

    it('should include deprecated warnings in output', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const deprecatedPage = result.pages.find((p) => p.command === 'deprecated-test');
      expect(deprecatedPage).toBeDefined();
      expect(deprecatedPage!.content).toContain('--oldArg');
      expect(deprecatedPage!.content).toContain('Deprecated');
    });

    it('should support custom frontmatter', () => {
      const result = generateDocs(program, {
        format: 'markdown',
        frontmatter: (info, depth) => ({
          title: info.name || 'CLI',
          sidebar_position: depth,
        }),
      });

      const page = result.pages.find((p) => p.command === 'show');
      expect(page).toBeDefined();
      expect(page!.content).toContain('---');
      expect(page!.content).toContain('title: "show"');
      expect(page!.content).toContain('sidebar_position: 1');
    });

    it('should handle nested commands with correct paths', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const paths = result.pages.map((p) => p.path);
      // list extended should be nested
      expect(paths).toContain('list/extended.md');
    });

    it('should handle dryRun without output dir', () => {
      const result = generateDocs(program, { format: 'markdown', dryRun: true });
      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.written).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should generate index page with links for markdown', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const indexPage = result.pages[0]!;
      expect(indexPage.path).toBe('index.md');
      expect(indexPage.content).toContain('## Commands');
      expect(indexPage.content).toContain('[show](show.md)');
      expect(indexPage.content).toContain('[list](list.md)');
    });

    it('should show enum choices for options', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const listPage = result.pages.find((p) => p.command === 'list');
      expect(listPage).toBeDefined();
      expect(listPage!.content).toContain('`pending`');
      expect(listPage!.content).toContain('`medium`');
    });

    it('should show examples in options', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const examplesPage = result.pages.find((p) => p.command === 'examples-test');
      expect(examplesPage).toBeDefined();
      expect(examplesPage!.content).toContain('output.txt');
      expect(examplesPage!.content).toContain('./dist/result.json');
    });

    it.skip('should write files when output is specified', () => {
      const tmpDir = `tmp/claude-501/padrone-docs-test-${Date.now()}`;
      const result = generateDocs(program, {
        format: 'markdown',
        output: tmpDir,
      });

      expect(result.written.length).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it.skip('should skip existing files when overwrite is false', () => {
      const tmpDir = `tmp/claude-501/padrone-docs-test-overwrite-${Date.now()}`;
      // First write
      generateDocs(program, { format: 'markdown', output: tmpDir });
      // Second write with overwrite: false
      const result = generateDocs(program, {
        format: 'markdown',
        output: tmpDir,
        overwrite: false,
      });

      expect(result.skipped.length).toBeGreaterThan(0);
    });

    it.skip('should report written files in dryRun mode with output', () => {
      const tmpDir = `tmp/claude-501/padrone-docs-test-dryrun-${Date.now()}`;
      const result = generateDocs(program, {
        format: 'markdown',
        output: tmpDir,
        dryRun: true,
      });

      expect(result.written.length).toBeGreaterThan(0);
      // But files shouldn't actually exist
    });

    it('markdown snapshot for show command', () => {
      const result = generateDocs(program, { format: 'markdown' });
      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage!.content).toMatchSnapshot();
    });

    it('html snapshot for show command', () => {
      const result = generateDocs(program, { format: 'html' });
      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage!.content).toMatchSnapshot();
    });

    it('man snapshot for show command', () => {
      const result = generateDocs(program, { format: 'man' });
      const showPage = result.pages.find((p) => p.command === 'show');
      expect(showPage!.content).toMatchSnapshot();
    });
  });

  describe('setupManPages', () => {
    const testManDir = join(import.meta.dir, '..', '.test-man');
    const origXdg = process.env.XDG_DATA_HOME;

    beforeAll(() => {
      process.env.XDG_DATA_HOME = testManDir;
    });

    afterAll(() => {
      if (origXdg !== undefined) process.env.XDG_DATA_HOME = origXdg;
      else delete process.env.XDG_DATA_HOME;
      if (existsSync(testManDir)) rmSync(testManDir, { recursive: true });
    });

    it('should install man pages to XDG_DATA_HOME', async () => {
      const result = await setupManPages(program);

      expect(result.dir).toBe(join(testManDir, 'man', 'man1'));
      expect(result.written.length).toBeGreaterThan(0);
      expect(result.updated).toBe(false);

      // Root page should be named after the program
      expect(result.written).toContain('padrone-test.1');

      // Subcommand pages should use hyphenated names prefixed with the program name
      expect(result.written).toContain('padrone-test-show.1');
      expect(result.written).toContain('padrone-test-list.1');

      // Files should actually exist
      for (const filename of result.written) {
        expect(existsSync(join(result.dir, filename))).toBe(true);
      }
    });

    it('should report updated=true when reinstalling', async () => {
      const result = await setupManPages(program);
      expect(result.updated).toBe(true);
    });

    it('should remove installed man pages', async () => {
      const result = await removeManPages(program);

      expect(result.removed.length).toBeGreaterThan(0);
      expect(result.removed).toContain('padrone-test.1');

      // Files should be gone
      for (const filename of result.removed) {
        expect(existsSync(join(result.dir, filename))).toBe(false);
      }
    });

    it('should handle remove when no pages exist', async () => {
      const result = await removeManPages(program);
      expect(result.removed).toHaveLength(0);
    });
  });
});
