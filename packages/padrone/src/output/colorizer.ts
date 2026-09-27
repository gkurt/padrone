// ANSI color/style codes
const ansiCodes: Record<AnsiStyle, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strikethrough: '\x1b[9m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Available ANSI styles that can be combined for each color role.
 */
export type AnsiStyle =
  | 'reset'
  | 'bold'
  | 'dim'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray';

/**
 * Maps each semantic color role to an array of ANSI styles.
 * Partial configs are merged with the default theme.
 */
export type ColorConfig = {
  command?: AnsiStyle[];
  arg?: AnsiStyle[];
  type?: AnsiStyle[];
  description?: AnsiStyle[];
  label?: AnsiStyle[];
  meta?: AnsiStyle[];
  example?: AnsiStyle[];
  exampleValue?: AnsiStyle[];
  deprecated?: AnsiStyle[];
};

export type Colorizer = {
  command: (text: string) => string;
  arg: (text: string) => string;
  type: (text: string) => string;
  description: (text: string) => string;
  label: (text: string) => string;
  meta: (text: string) => string;
  example: (text: string) => string;
  exampleValue: (text: string) => string;
  deprecated: (text: string) => string;
};

// ============================================================================
// Predefined Themes
// ============================================================================

const defaultTheme: Required<ColorConfig> = {
  command: ['cyan', 'bold'],
  arg: ['green'],
  type: ['yellow'],
  description: ['dim'],
  label: ['bold'],
  meta: ['gray'],
  example: ['underline'],
  exampleValue: ['italic'],
  deprecated: ['strikethrough', 'gray'],
};

const oceanTheme: Required<ColorConfig> = {
  command: ['blue', 'bold'],
  arg: ['cyan'],
  type: ['green'],
  description: ['dim'],
  label: ['bold'],
  meta: ['gray'],
  example: ['underline', 'cyan'],
  exampleValue: ['italic'],
  deprecated: ['strikethrough', 'gray'],
};

const warmTheme: Required<ColorConfig> = {
  command: ['yellow', 'bold'],
  arg: ['red'],
  type: ['magenta'],
  description: ['dim'],
  label: ['bold'],
  meta: ['gray'],
  example: ['underline', 'yellow'],
  exampleValue: ['italic'],
  deprecated: ['strikethrough', 'gray'],
};

const monochromeTheme: Required<ColorConfig> = {
  command: ['bold'],
  arg: ['underline'],
  type: ['dim'],
  description: ['dim'],
  label: ['bold'],
  meta: ['dim'],
  example: ['underline'],
  exampleValue: ['italic'],
  deprecated: ['strikethrough', 'dim'],
};

/**
 * Available predefined color themes.
 */
export type ColorTheme = 'default' | 'ocean' | 'warm' | 'monochrome';

export const colorThemes: Record<ColorTheme, Required<ColorConfig>> = {
  default: defaultTheme,
  ocean: oceanTheme,
  warm: warmTheme,
  monochrome: monochromeTheme,
};

export function makeStyleFn(styles: AnsiStyle[]): (text: string) => string {
  const prefix = styles.map((s) => ansiCodes[s]).join('');
  return (text: string) => `${prefix}${text}${ansiCodes.reset}`;
}

function resolveConfig(config?: ColorTheme | ColorConfig): Required<ColorConfig> {
  if (!config) return defaultTheme;
  if (typeof config === 'string') return colorThemes[config] ?? defaultTheme;
  return { ...defaultTheme, ...config };
}

export function createColorizer(config?: ColorTheme | ColorConfig): Colorizer {
  const resolved = resolveConfig(config);
  return {
    command: makeStyleFn(resolved.command),
    arg: makeStyleFn(resolved.arg),
    type: makeStyleFn(resolved.type),
    description: makeStyleFn(resolved.description),
    label: makeStyleFn(resolved.label),
    meta: makeStyleFn(resolved.meta),
    example: makeStyleFn(resolved.example),
    exampleValue: makeStyleFn(resolved.exampleValue),
    deprecated: makeStyleFn(resolved.deprecated),
  };
}
