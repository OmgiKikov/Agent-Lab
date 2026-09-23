import { execFile } from 'node:child_process';
import { access, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GatewayStatus } from '../dist/giga-transport.js';
import { type Feed } from './conversation.ts';
import { type Row } from './render/theme.ts';

/*
 * Подготовка без терминала: личный шлюз моделей и выгрузки .xlsx, которые разговор сам прочитать
 * не может. Здесь только слова для владельца и запуск конвертеров; настройка и транспорт — в src.
 */

const FIELD_NAMES: Record<string, string> = {
  AGENT_LAB_GATEWAY_URL: 'адрес шлюза',
  AGENT_LAB_GATEWAY_CERT_PATH: 'сертификат',
  AGENT_LAB_GATEWAY_KEY_PATH: 'ключ',
  AGENT_LAB_GATEWAY_CA_PATH: 'цепочка CA',
};
const MAX_WORKBOOK_ROWS_OUTPUT = 4000;

/** Как владелец назвал шлюз и свои файлы: пути ещё не приведены к абсолютным. */
export interface GatewayInput { url: string; certPath: string; keyPath: string; caPath?: string; insecure?: boolean }
export type WorkbookKind = 'dialogues' | 'cases';
export interface WorkbookOptions { limit?: number; multiTurnOnly?: boolean; sheets?: string[]; passing?: boolean }
export interface WorkbookImport { files: { dialoguesFile?: string; goldenFile?: string; taskFile?: string }; report: string[] }

const row = (text: string, tone?: Row['tone']): Row => ({ text, ...(tone ? { tone } : {}) });

export function fieldNames(variables: string[]): string {
  return variables.map(name => FIELD_NAMES[name] ?? name).join(', ');
}

/** `~/…` и относительные пути владелец пишет так, как видит их в терминале; в файл уходит абсолютный путь. */
export function ownerPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(1));
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/** Категория отказа из src/giga-provider.ts → что чинить. Категория уже не несёт ни путей, ни тела ответа. */
export function gatewayFailureText(category: string): string {
  if (category === 'bad configuration') return 'не удалось прочитать сертификат или ключ. Проверьте пути.';
  if (/ENOTFOUND|EAI_AGAIN/.test(category)) return 'адрес шлюза не найден в сети. Проверьте адрес и VPN.';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(category) || category === 'timeout or aborted') return 'шлюз не отвечает. Проверьте VPN и адрес.';
  if (/CERT|SIGNATURE|SELF_SIGNED|ISSUER/.test(category)) return 'не удалось проверить сертификат самого шлюза. Укажите цепочку CA или, осознанно, отключите проверку.';
  if (/EPROTO|ERR_SSL|bad decrypt|key values mismatch/i.test(category)) return 'сертификат и ключ не подходят друг к другу или к шлюзу.';
  if (category === 'HTTP 401' || category === 'HTTP 403') return 'шлюз не принял сертификат: у него нет доступа.';
  if (category === 'HTTP 404') return 'по этому адресу нет каталога моделей. Нужен корень шлюза, без /api.';
  if (category === 'empty catalog') return 'шлюз ответил, но чатовых моделей для этого сертификата нет.';
  return `шлюз ответил ошибкой (${category}).`;
}

export function gatewayFeed(status: GatewayStatus, models: string[] | undefined, environmentWins: boolean): Feed {
  const rows: Row[] = [];
  if (models?.length) {
    rows.push(row(`Шлюз моделей подключён: моделей ${models.length}. Выбор — /model, провайдер giga.`, 'success'));
    rows.push(row(`Модели: ${models.slice(0, 12).join(', ')}${models.length > 12 ? ', …' : ''}`, 'muted'));
  } else if (status.settingsError) {
    rows.push(row(`Личная настройка шлюза повреждена. Настройте шлюз заново.`, 'error'));
  } else if (!status.configured) {
    rows.push(row(`Шлюз моделей не подключён: не хватает — ${fieldNames(status.missingVariables)}.`, 'warning'));
    rows.push(row('/agent-lab gateway или просьба в разговоре: адрес шлюза и пути к вашим сертификату и ключу. Lab проверит доступ и запомнит.', 'muted'));
  } else {
    rows.push(row('Шлюз настроен, но в этом разговоре не подключился. Попросите проверить доступ.', 'warning'));
  }
  if (status.unreadableFiles.length) rows.push(row(`Не читается: ${fieldNames(status.unreadableFiles)}.`, 'error'));
  if (environmentWins) rows.push(row('Заданы переменные AGENT_LAB_GATEWAY_*: они важнее личной настройки.', 'muted'));
  return { rows };
}

/**
 * Конвертеры выгрузок agent_oc (examples/agent-oc-*.py) — единственное место, где знают колонки этих
 * .xlsx. Нужен python3 с openpyxl, то есть окружение, из которого запущен Lab. Результат ложится в
 * `.agent-lab/imports`: это прод-диалоги, им место рядом с прогонами и с правами только для владельца.
 */
export async function importWorkbook(kind: WorkbookKind, input: string, options: WorkbookOptions, cwd: string, labRoot: string, signal?: AbortSignal): Promise<WorkbookImport> {
  if (extname(input).toLowerCase() !== '.xlsx') throw new Error('Нужен файл .xlsx. JSON и JSONL передавайте сборке сценариев напрямую.');
  try { await access(input); } catch { throw new Error(`Файл ${basename(input)} не найден. Проверьте путь.`); }
  const directory = resolve(cwd, '.agent-lab', 'imports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = basename(input, extname(input)).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80) || 'import';
  const { script, args, files }: { script: string; args: string[]; files: WorkbookImport['files'] } = kind === 'dialogues'
    ? dialoguesCommand(input, options, directory, stem) : casesCommand(input, options, directory, stem);
  const report = await runConverter(join(labRoot, 'examples', script), args, signal);
  for (const file of [...Object.values(files), files.dialoguesFile ? `${files.dialoguesFile}.meta.json` : undefined]) if (file) await chmod(file, 0o600);
  return { files, report };
}

function dialoguesCommand(input: string, options: WorkbookOptions, directory: string, stem: string) {
  const dialoguesFile = join(directory, `${stem}.dialogues.jsonl`);
  const args = ['--input', input, '--output', dialoguesFile, ...sheetArgs(options), ...(options.limit ? ['--limit', String(options.limit)] : []), ...(options.multiTurnOnly ? ['--multi-turn-only'] : [])];
  return { script: 'agent-oc-dialogues.py', args, files: { dialoguesFile } };
}

function casesCommand(input: string, options: WorkbookOptions, directory: string, stem: string) {
  const taskFile = join(directory, `${stem}.task.json`);
  const goldenFile = join(directory, `${stem}.golden.json`);
  const args = ['--input', input, '--output', taskFile, '--golden-output', goldenFile, ...sheetArgs(options), ...(options.limit ? ['--limit', String(options.limit)] : []), ...(options.passing ? ['--passing'] : [])];
  return { script: 'agent-oc-cases.py', args, files: { goldenFile, taskFile } };
}

const sheetArgs = (options: WorkbookOptions) => (options.sheets ?? []).flatMap(sheet => ['--sheet', sheet]);

async function runConverter(script: string, args: string[], signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('python3', [script, ...args], { timeout: 120000, maxBuffer: 1 << 20, ...(signal ? { signal } : {}) });
    return lines(stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT') throw new Error('Не найден python3. Запустите Lab из окружения, где есть python3 с openpyxl (например, conda activate agent_oc).');
    const stderr = failure.stderr ?? '';
    if (/No module named ['"]?openpyxl/.test(stderr)) throw new Error('Для чтения .xlsx нужен openpyxl. Запустите Lab из окружения agent_oc (conda activate agent_oc) или поставьте openpyxl.');
    const reason = lines(stderr).filter(line => !/^\s*(Traceback|File "|\^)/.test(line)).at(-1);
    throw new Error(`Не удалось прочитать .xlsx${reason ? `: ${reason}` : '.'}`);
  }
}

const lines = (text: string) => text.slice(0, MAX_WORKBOOK_ROWS_OUTPUT).split('\n').map(line => line.trim()).filter(Boolean);
