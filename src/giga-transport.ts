import { accessSync, constants, readFileSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';

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

/**
 * Возвращает `undefined`, если не задана обязательная переменная; бросает, если заданный путь не читается.
 *
 * Версию пути выбирает вызывающий код (чат живёт на /v2, каталог на /v1),
 * поэтому хвостовой /v1 или /v2 из настроенного адреса срезается.
 */
export function readGigaConfig(env: Record<string, string | undefined> = process.env): GigaConfig | undefined {
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
export function missingGigaVariables(env: Record<string, string | undefined> = process.env): string[] {
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
export function unreadableGigaFiles(env: Record<string, string | undefined> = process.env): string[] {
  const names = ['AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH', 'AGENT_LAB_GATEWAY_CA_PATH'] as const;
  return names.filter(name => {
    const path = env[name];
    if (!path) return false;
    try { accessSync(path, constants.R_OK); return false; } catch { return true; }
  });
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
