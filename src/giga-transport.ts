import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

export interface GigaConfig {
  baseUrl: string;
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

// AGENT_LAB_GATEWAY_INSECURE отключает проверку сертификата шлюза без каких-либо других признаков в
// работе провайдера; предупреждение печатается один раз за процесс, чтобы боевой запуск
// с этим флагом не остался незамеченным, но не заспамил лог на каждое обращение к конфигу.
let insecureWarningLogged = false;

type Environment = Record<string, string | undefined>;

const absolutePath = z.string().trim().min(1).max(4000).refine(isAbsolute, 'Нужен абсолютный путь');
/**
 * Личная настройка шлюза: сертификат у каждого пользователя свой, поэтому файл живёт в домашнем
 * каталоге, а не в `.agent-lab` проекта. Хранятся только пути — копия ключа пережила бы его отзыв.
 */
export const gatewaySettingsSchema = z.strictObject({
  format: z.literal('agent-lab-gateway-1'),
  url: z.string().trim().url().max(2000),
  certPath: absolutePath,
  keyPath: absolutePath,
  caPath: absolutePath.optional(),
  insecure: z.boolean().optional(),
});
export type GatewaySettings = z.infer<typeof gatewaySettingsSchema>;

export function gatewayFile(env: Environment = process.env): string {
  return env.AGENT_LAB_GATEWAY_FILE || join(homedir(), '.agent-lab', 'gateway.json');
}

/** `undefined`, если файла нет; бросает, если файл есть, но не читается как настройка шлюза. */
export function readGatewaySettings(file: string): GatewaySettings | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`Файл настройки шлюза ${file} повреждён: это не JSON`); }
  const parsed = gatewaySettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Файл настройки шлюза ${file} повреждён: ${parsed.error.issues[0]?.message ?? 'неверный формат'}`);
  return parsed.data;
}

/** Атомарно и только для владельца: в файле пути к личному ключу. */
export async function saveGatewaySettings(settings: GatewaySettings, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(gatewaySettingsSchema.parse(settings), null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function forgetGatewaySettings(file: string): Promise<boolean> {
  try { await rm(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function settingsEnvironment(settings: GatewaySettings): Environment {
  return {
    AGENT_LAB_GATEWAY_URL: settings.url,
    AGENT_LAB_GATEWAY_CERT_PATH: settings.certPath,
    AGENT_LAB_GATEWAY_KEY_PATH: settings.keyPath,
    AGENT_LAB_GATEWAY_CA_PATH: settings.caPath,
    AGENT_LAB_GATEWAY_INSECURE: settings.insecure ? '1' : undefined,
  };
}

/**
 * Переменные окружения поверх личного файла, по одной: CI и разовый прогон на другом контуре
 * экспортируют переменные и не трогают личную настройку.
 */
export function gatewayEnvironment(env: Environment = process.env, file = gatewayFile(env)): Environment {
  const settings = readGatewaySettings(file);
  const merged: Environment = settings ? settingsEnvironment(settings) : {};
  for (const [name, value] of Object.entries(env)) if (name.startsWith('AGENT_LAB_GATEWAY_') && value) merged[name] = value;
  return merged;
}

/**
 * Возвращает `undefined`, если не задана обязательная переменная; бросает, если заданный путь не читается.
 *
 * Версию пути выбирает вызывающий код (чат живёт на /v2, каталог на /v1),
 * поэтому хвостовой /v1 или /v2 из настроенного адреса срезается.
 */
export function readGigaConfig(env: Environment = gatewayEnvironment()): GigaConfig | undefined {
  // Имена намеренно свои, а не GIGACHAT_*: проверяемый агент может ходить в GigaChat по
  // собственным сертификатам, и его переменные живут в том же окружении — Agent Lab запускает
  // его дочерним процессом. Общее имя означало бы, что один из двух сервисов молча получит
  // чужой сертификат.
  const url = env.AGENT_LAB_GATEWAY_URL;
  const certPath = env.AGENT_LAB_GATEWAY_CERT_PATH;
  const keyPath = env.AGENT_LAB_GATEWAY_KEY_PATH;
  const caPath = env.AGENT_LAB_GATEWAY_CA_PATH;
  if (!url || !certPath || !keyPath) return undefined;
  const rejectUnauthorized = env.AGENT_LAB_GATEWAY_INSECURE !== '1';
  if (!rejectUnauthorized && !insecureWarningLogged) {
    insecureWarningLogged = true;
    process.stderr.write('giga: AGENT_LAB_GATEWAY_INSECURE=1 — проверка сертификата шлюза отключена\n');
  }
  return {
    baseUrl: url.replace(/\/+$/, '').replace(/\/v[12]$/, ''),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: caPath ? readFileSync(caPath) : undefined,
    rejectUnauthorized,
  };
}

/**
 * Какие обязательные переменные шлюза не заданы. Провайдер без них просто не появляется,
 * и снаружи это неотличимо от отказа авторизации Pi — команда status показывает этот список.
 */
export function missingGigaVariables(env: Environment = gatewayEnvironment()): string[] {
  const missing: string[] = [];
  for (const name of ['AGENT_LAB_GATEWAY_URL', 'AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH'] as const) {
    if (!env[name]) missing.push(name);
  }
  return missing;
}

/**
 * Имена переменных, чей файл не читается. Значения не возвращаются: путь к приватному ключу
 * не должен попадать в вывод команд и записи прогонов. Относительный путь считается от текущего
 * каталога, поэтому переменные проекта с относительными путями видны здесь, а не в общем отказе.
 */
export function unreadableGigaFiles(env: Environment = gatewayEnvironment()): string[] {
  const names = ['AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH', 'AGENT_LAB_GATEWAY_CA_PATH'] as const;
  return names.filter(name => {
    const path = env[name];
    if (!path) return false;
    try { accessSync(path, constants.R_OK); return false; } catch { return true; }
  });
}

export interface GatewayStatus { configured: boolean; missingVariables: string[]; unreadableFiles: string[]; settingsFile: string; settingsError?: string }

/** Чинить окружение или доступ: без сети, без путей и содержимого сертификатов. */
export function gatewayStatus(env: Environment = process.env): GatewayStatus {
  const settingsFile = gatewayFile(env);
  let merged: Environment;
  try { merged = gatewayEnvironment(env, settingsFile); }
  catch (error) {
    const own = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('AGENT_LAB_GATEWAY_')));
    const missingVariables = missingGigaVariables(own);
    return { configured: false, missingVariables, unreadableFiles: unreadableGigaFiles(own), settingsFile, settingsError: error instanceof Error ? error.message : String(error) };
  }
  const missingVariables = missingGigaVariables(merged);
  return { configured: missingVariables.length === 0, missingVariables, unreadableFiles: unreadableGigaFiles(merged), settingsFile };
}

export type GigaTransport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

/** Собирает опции для `https.request`: клиентский сертификат аутентифицирует запрос, заголовка Authorization нет. */
export function requestOptions(config: GigaConfig, path: string, payload: string | undefined, timeoutMs: number): RequestOptions {
  const url = new URL(`${config.baseUrl}${path}`);
  return {
    hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
    method: payload === undefined ? 'GET' : 'POST',
    cert: config.cert, key: config.key, ca: config.ca,
    rejectUnauthorized: config.rejectUnauthorized, timeout: timeoutMs,
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
}

export function createGigaTransport(config: GigaConfig, timeoutMs = 120000): GigaTransport {
  return (path, body, signal) => new Promise((resolve, reject) => {
    // addEventListener('abort', ...) below only fires on a FUTURE abort; a signal that is
    // already aborted would otherwise send the request anyway and wait for a response that never comes.
    if (signal?.aborted) { reject(new Error('Giga request aborted')); return; }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(requestOptions(config, path, payload, timeoutMs), response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      // Without this, a connection cut mid-body (proxy reset, truncated gateway response)
      // leaves the promise pending forever: 'end' never fires and 'req' has already succeeded.
      response.on('error', reject);
    });
    const abort = () => req.destroy(new Error('Giga request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => req.destroy(new Error('Giga request timed out')));
    req.on('error', reject);
    req.on('close', () => signal?.removeEventListener('abort', abort));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
