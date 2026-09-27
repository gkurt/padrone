/**
 * Targeted edits of JSON with comments (JSONC) text: a value is replaced, inserted or removed in place,
 * so comments, key order and formatting elsewhere in the file are kept.
 */

type Member = { key: string; start: number; end: number; valueStart: number; value: Node };
type Node = { start: number; end: number; members?: Member[] };

class JsoncScanner {
  i = 0;
  constructor(readonly text: string) {}

  skipTrivia(): void {
    const { text } = this;
    while (this.i < text.length) {
      const ch = text[this.i]!;
      if (/\s/.test(ch)) this.i++;
      else if (ch === '/' && text[this.i + 1] === '/') while (this.i < text.length && text[this.i] !== '\n') this.i++;
      else if (ch === '/' && text[this.i + 1] === '*') {
        const close = text.indexOf('*/', this.i + 2);
        this.i = close === -1 ? text.length : close + 2;
      } else return;
    }
  }

  fail(): never {
    throw new SyntaxError(`Unexpected ${this.i < this.text.length ? `"${this.text[this.i]}"` : 'end of input'} at position ${this.i}`);
  }

  string(): string {
    const start = this.i;
    for (this.i++; this.i < this.text.length && this.text[this.i] !== '"'; this.i++) if (this.text[this.i] === '\\') this.i++;
    if (this.i >= this.text.length) this.fail();
    this.i++;
    return JSON.parse(this.text.slice(start, this.i));
  }

  value(): Node {
    this.skipTrivia();
    const start = this.i;
    const ch = this.text[this.i];
    if (ch === '"') {
      this.string();
      return { start, end: this.i };
    }
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      const members: Member[] = [];
      this.i++;
      for (;;) {
        this.skipTrivia();
        if (this.text[this.i] === close) break;
        if (ch === '[') this.value();
        else {
          if (this.text[this.i] !== '"') this.fail();
          const memberStart = this.i;
          const key = this.string();
          this.skipTrivia();
          if (this.text[this.i] !== ':') this.fail();
          this.i++;
          const value = this.value();
          members.push({ key, start: memberStart, end: value.end, valueStart: value.start, value });
        }
        this.skipTrivia();
        if (this.text[this.i] === ',') this.i++;
        else if (this.text[this.i] !== close) this.fail();
      }
      this.i++;
      return { start, end: this.i, ...(ch === '{' && { members }) };
    }
    const literal = /^[^\s,\]}/]+/.exec(this.text.slice(this.i))?.[0];
    if (!literal) this.fail();
    this.i += literal.length;
    return { start, end: this.i };
  }
}

function parseTree(text: string): Node | undefined {
  const scanner = new JsoncScanner(text);
  scanner.skipTrivia();
  if (scanner.i >= text.length) return undefined;
  const root = scanner.value();
  scanner.skipTrivia();
  if (scanner.i < text.length) scanner.fail();
  return root;
}

const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1;
const lineEnd = (text: string, index: number) => (text.indexOf('\n', index) + 1 || text.length + 1) - 1;
/** The whitespace before `index` on its line, or `undefined` when something else comes first. */
function indentAt(text: string, index: number): string | undefined {
  const before = text.slice(lineStart(text, index), index);
  return /^[ \t]*$/.test(before) ? before : undefined;
}
/** Whether only whitespace, or whitespace and a line comment, follow `index` on its line. */
const restOfLineIsTrivia = (text: string, index: number) => /^[ \t]*(?:\/\/.*)?\r?$/.test(text.slice(index, lineEnd(text, index)));

function detectIndentUnit(text: string, root: Node): string {
  const first = root.members?.[0];
  const indent = first ? indentAt(text, first.start) : undefined;
  return indent || '  ';
}

const nest = (path: readonly string[], value: unknown): unknown => path.reduceRight<unknown>((v, key) => ({ [key]: v }), value);

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);

/** `value` as JSON text for a spot at `indent`. */
function format(value: unknown, indent: string, unit: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

function findMember(node: Node, key: string): Member | undefined {
  return node.members?.findLast((member) => member.key === key);
}

/**
 * `text` with the value at `path` set to `value` (a JSON value), adding the objects on the way when missing.
 * An empty text becomes a new object. Throws a `SyntaxError` when the text isn't valid JSONC or isn't an object.
 */
export function setJsoncValue(text: string, path: readonly string[], value: unknown): string {
  const root = parseTree(text);
  if (!root) return `${JSON.stringify(nest(path, value), null, 2)}\n`;
  if (!root.members) throw new SyntaxError('The config is not an object');
  const unit = detectIndentUnit(text, root);

  let node = root;
  let nodeIndent = indentAt(text, root.start) ?? '';
  for (let i = 0; i < path.length; i++) {
    const member = findMember(node, path[i]!);
    const memberIndent = member ? (indentAt(text, member.start) ?? nodeIndent + unit) : nodeIndent + unit;
    if (member && (i === path.length - 1 || !member.value.members)) {
      return splice(text, member.valueStart, member.value.end, format(nest(path.slice(i + 1), value), memberIndent, unit));
    }
    if (member) {
      node = member.value;
      nodeIndent = memberIndent;
      continue;
    }
    const entry = `${JSON.stringify(path[i])}: ${format(nest(path.slice(i + 1), value), memberIndent, unit)}`;
    return insertMember(text, node, entry, memberIndent, nodeIndent);
  }
  return text;
}

function insertMember(text: string, node: Node, entry: string, indent: string, closingIndent: string): string {
  const last = node.members!.at(-1);
  const closeBrace = node.end - 1;
  if (!last) {
    const inner = text.slice(node.start + 1, closeBrace);
    if (/^\s*$/.test(inner)) return splice(text, node.start + 1, closeBrace, `\n${indent}${entry}\n${closingIndent}`);
    return splice(text, node.start + 1, node.start + 1, `\n${indent}${entry}`);
  }
  const multiline = text.slice(node.start, closeBrace).includes('\n');
  const trailingComma = commaAfter(text, last.end);
  const commaEnd = trailingComma ?? last.end;
  if (!multiline) return splice(text, commaEnd, commaEnd, `${trailingComma ? ' ' : ', '}${entry}${trailingComma ? ',' : ''}`);
  // After a comment that ends the last member's line, so the comment stays with it
  const at = restOfLineIsTrivia(text, commaEnd) ? Math.min(lineEnd(text, commaEnd), closeBrace) : commaEnd;
  const inserted = splice(text, at, at, `\n${indent}${entry}${trailingComma ? ',' : ''}`);
  return trailingComma ? inserted : splice(inserted, last.end, last.end, ',');
}

/**
 * `text` without the value at `path`, and without objects left empty by removing it; `undefined` when it isn't set.
 * Throws a `SyntaxError` when the text isn't valid JSONC.
 */
export function removeJsoncValue(text: string, path: readonly string[]): string | undefined {
  const root = parseTree(text);
  if (!root?.members) return undefined;
  const chain: Node[] = [root];
  let member: Member | undefined;
  for (let i = 0; i < path.length; i++) {
    member = findMember(chain.at(-1)!, path[i]!);
    if (!member) return undefined;
    if (i < path.length - 1) {
      if (!member.value.members) return undefined;
      chain.push(member.value);
    }
  }
  const parent = chain.at(-1)!;
  let updated = removeMember(text, parent, member!);
  // Duplicate keys: an earlier one would take effect
  while (true) {
    const again = removeJsoncValue(updated, path);
    if (again === undefined) break;
    updated = again;
  }
  if (path.length > 1 && parent.members!.length === 1) return removeJsoncValue(updated, path.slice(0, -1)) ?? updated;
  return updated;
}

function removeMember(text: string, parent: Node, member: Member): string {
  const index = parent.members!.indexOf(member);
  const previous = parent.members![index - 1];
  const ownLine = indentAt(text, member.start) !== undefined;
  const lineFrom = (start: number) => Math.max(lineStart(text, start) - 1, parent.start + 1);
  const comma = commaAfter(text, member.end);

  if (comma !== undefined) {
    if (!ownLine) return splice(text, member.start, comma + (/^[ \t]*/.exec(text.slice(comma))?.[0].length ?? 0), '');
    // Along with a comment after its comma on the same line
    return splice(text, lineFrom(member.start), restOfLineIsTrivia(text, comma) ? lineEnd(text, comma) : comma, '');
  }
  if (!ownLine) return splice(text, previous ? previous.end : member.start, member.end, '');
  const removed = splice(text, lineFrom(member.start), restOfLineIsTrivia(text, member.end) ? lineEnd(text, member.end) : member.end, '');
  // The member before it is now the last one: drop its comma
  const previousComma = previous && commaAfter(removed, previous.end);
  return previousComma === undefined ? removed : splice(removed, previousComma - 1, previousComma, '');
}

/** The index after the comma that follows `index` (past whitespace and comments), if one does. */
function commaAfter(text: string, index: number): number | undefined {
  const scanner = new JsoncScanner(text);
  scanner.i = index;
  scanner.skipTrivia();
  return text[scanner.i] === ',' ? scanner.i + 1 : undefined;
}
