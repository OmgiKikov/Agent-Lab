import { parseArgs } from 'node:util';

/*
 * The command line as the owner typed it: the command, then the flags that command takes. A flag of another command, an
 * unknown one, a flag without its value or a word nobody asked for is refused in the owner's words with the next step —
 * never ignored, never an English diagnostic. The flags' types live here once; each command names the ones it takes.
 */

/** Every flag of the command line, by its type. */
export const FLAGS = {
  'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' },
  before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  format: { type: 'string' }, json: { type: 'boolean' },
  connection: { type: 'string' }, directory: { type: 'string' }, 'code-only': { type: 'boolean' },
  'dialogues-file': { type: 'string' }, trial: { type: 'string', multiple: true },
  yes: { type: 'boolean' }, case: { type: 'string', multiple: true }, control: { type: 'string', multiple: true }, parallel: { type: 'string' },
  card: { type: 'string' }, choice: { type: 'string' }, text: { type: 'string' }, check: { type: 'boolean' }, resume: { type: 'boolean' }, accept: { type: 'boolean' }, variations: { type: 'boolean' }, convert: { type: 'boolean' },
  expectation: { type: 'string' },
  'agent-version': { type: 'string' }, unknown: { type: 'boolean' }, import: { type: 'string' },
  file: { type: 'string' }, sheet: { type: 'string' }, 'id-column': { type: 'string' }, 'text-column': { type: 'string' }, separator: { type: 'string' },
  markers: { type: 'string' }, 'role-column': { type: 'string' }, roles: { type: 'string' }, 'order-column': { type: 'string' }, 'row-order': { type: 'boolean' },
  where: { type: 'string' }, 'no-separator': { type: 'boolean' }, 'collapse-repeats': { type: 'boolean' }, 'keep-repeats': { type: 'boolean' },
  situations: { type: 'string' }, 'prompts-from': { type: 'string' }, prompt: { type: 'string', multiple: true }, prompts: { type: 'string' },
  planted: { type: 'string' }, controls: { type: 'string' },
  curl: { type: 'string' }, message: { type: 'string' }, conversation: { type: 'string', multiple: true }, reply: { type: 'string' },
  'operator-rules': { type: 'string' }, 'bind-rule': { type: 'string', multiple: true }, 'unbind-rule': { type: 'string', multiple: true },
} as const;
export type Flag = keyof typeof FLAGS;
export type Flags = ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>['values'];

/** Taken by every command: where the records are, and the help. */
const EVERYWHERE: readonly Flag[] = ['data-dir', 'help'];

/** A command line that does not say what it means. The message is the owner's: what is wrong and what to type instead. */
export class UsageError extends Error {}

/** What the owner typed: the command (none: they asked for the help), the flags it takes, and whether they asked for its help. */
export interface CommandLine { name: string | undefined; values: Flags; help: boolean }

const flagList = (flags: readonly Flag[]) => flags.filter(flag => !EVERYWHERE.includes(flag)).map(flag => `--${flag}`).join(', ');

/** The line read loosely, so the command is known before its flags are judged — whatever order the owner typed them in. */
const looseTokens = (args: readonly string[]) => parseArgs({ args: [...args], options: FLAGS, allowPositionals: true, strict: false, tokens: true }).tokens;

/** The command `args` name, known even when the rest of the line is wrong: its failure has the command's exit code. */
export function commandOf(args: readonly string[]): string | undefined {
  return looseTokens(args).find(token => token.kind === 'positional')?.value;
}

/**
 * Reads `args` for the command they name. `flagsOf` gives the flags a command takes, undefined for no such command;
 * `names` are the commands there are, said when the owner names another one.
 */
export function readCommandLine(args: readonly string[], flagsOf: (name: string) => readonly Flag[] | undefined, names: readonly string[]): CommandLine {
  const tokens = looseTokens(args);
  const words = tokens.filter(token => token.kind === 'positional');
  const name = words[0]?.value;
  const accepted = name === undefined ? EVERYWHERE : flagsOf(name);
  if (!accepted) throw new UsageError(`Такой команды нет: «${name}». Команды: ${names.join(', ')}. Подробно: agent-lab --help.`);
  const known = new Set<string>([...EVERYWHERE, ...accepted]);
  const where = name === undefined ? 'agent-lab' : `agent-lab ${name}`;
  const own = name === undefined ? '' : ` Флаги команды: ${flagList(accepted) || 'нет'}. Подробно: ${where} --help.`;
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const flag = token.name === 'h' ? 'help' : token.name;
    if (!known.has(flag)) throw new UsageError(`У команды ${where} нет флага ${token.rawName}.${own}`);
    const type = FLAGS[flag as Flag].type;
    if (type === 'boolean' && token.value !== undefined) throw new UsageError(`Флаг ${token.rawName} пишется без значения: ${token.rawName}.`);
    // A string flag at the end, or followed by another flag, has lost its value.
    if (type === 'string' && (token.value === undefined || !token.inlineValue && token.value.startsWith('--')))
      throw new UsageError(`После ${token.rawName} нужно значение: ${token.rawName} ЗНАЧЕНИЕ${token.value === undefined ? '' : ` (сейчас за ним стоит ${token.value})`}.`);
  }
  const extra = words[1];
  if (extra) throw new UsageError(`Лишнее слово «${extra.value}»: команда ${where} принимает только флаги. Значение пишется после своего флага, например --id ЗНАЧЕНИЕ.`);
  const options = Object.fromEntries([...known].map(flag => [flag, FLAGS[flag as Flag]]));
  const { values } = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  return { name, values: values as Flags, help: !!values.help };
}
