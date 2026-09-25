import { accessSync, constants, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { z } from 'zod';

/*
 * The wire of the personal model gateway (provider giga): where its configuration comes from (the owner's settings file,
 * with AGENT_LAB_GATEWAY_* variables over it), one HTTPS request authenticated by the owner's client certificate under
 * one deadline and a size cap, and what Node's TLS errors say about whose certificate failed. giga-provider.ts turns
 * all of it into a provider and into the owner's words.
 */

export interface GigaConfig {
  baseUrl: string;
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

// AGENT_LAB_GATEWAY_INSECURE turns off the check of the gateway's certificate with no other sign in the provider's work.
// The warning is printed once per process: a production run with the flag does not go unnoticed, and the log is not
// flooded on every read of the configuration.
let insecureWarningLogged = false;

export type Environment = Record<string, string | undefined>;

const absolutePath = z.string().trim().min(1).max(4000).refine(isAbsolute, 'Нужен абсолютный путь');
/**
 * The owner's personal gateway settings. Every user has a certificate of their own, so the file lives in the home
 * folder, not in a project's `.agent-lab`. Only paths are kept: a copy of the key would outlive its revocation.
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

/** `undefined` when there is no file; throws when the file exists but does not read as gateway settings. */
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

/** Written atomically and readable by the owner only: the file holds the path to a private key. */
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
 * The variables over the personal file, one field each: CI and a one-off run against another environment export
 * variables and leave the personal settings alone.
 */
export function gatewayEnvironment(env: Environment = process.env, file = gatewayFile(env)): Environment {
  const settings = readGatewaySettings(file);
  const merged: Environment = settings ? settingsEnvironment(settings) : {};
  for (const [name, value] of Object.entries(env)) if (name.startsWith('AGENT_LAB_GATEWAY_') && value) merged[name] = value;
  return merged;
}

/**
 * `undefined` when a required variable is not set; throws when a configured path does not read.
 *
 * The caller picks the path version (chat lives on /v2, the catalog on /v1), so a trailing /v1 or /v2 of the
 * configured address is cut off.
 */
export function readGigaConfig(env: Environment = gatewayEnvironment()): GigaConfig | undefined {
  // The names are deliberately Lab's own, not GIGACHAT_*: the agent under test may reach GigaChat with its own
  // certificates, and its variables live in the same environment, since Agent Lab starts it as a child process. A shared
  // name would mean that one of the two services silently gets the other's certificate.
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
 * Which required gateway variables are not set. Without them the provider simply does not appear, which from outside
 * cannot be told from a refused Pi login, so the status command shows this list.
 */
export function missingGigaVariables(env: Environment = gatewayEnvironment()): string[] {
  const missing: string[] = [];
  for (const name of ['AGENT_LAB_GATEWAY_URL', 'AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH'] as const) {
    if (!env[name]) missing.push(name);
  }
  return missing;
}

/**
 * Names of the variables whose file does not read. Values are never returned: the path to a private key must not reach
 * command output or run records. A relative path counts from the current folder, so a project's variables with relative
 * paths are named here rather than lost in a general refusal.
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

/** What to fix, the environment or the access: no network, no paths and no certificate contents. */
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

/**
 * One request's limits. `timeoutMs` bounds the whole exchange, from the connection to the last byte of the answer;
 * `signal` is the caller's stop.
 */
export interface GigaRequestOptions { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
export type GigaTransport = (path: string, body?: unknown, options?: GigaRequestOptions) => Promise<{ status: number; text: string }>;

/** A request whose caller names no deadline gets as long as Pi's own providers give one by default. */
const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * The largest response read whole. The longest answer a caller may ask for (32 768 tokens, escaped Cyrillic JSON
 * included) stays well under it; a body over it is not a model's answer and is never held in memory whole.
 */
const MAX_RESPONSE_BYTES = 2_000_000;
/** Node's timers take at most 2^31−1 ms and fire at once for a longer delay; Pi passes exactly this for «no limit». */
const MAX_TIMER_MS = 2_147_483_647;

/** Why a request got no response to read: its deadline passed, its caller stopped it, or the response outgrew the cap. */
export type GigaTransportFailure = 'timeout' | 'aborted' | 'too large';
/** A request that failed for a reason of the transport's own; Node's connection errors pass through with their codes. */
export class GigaTransportError extends Error {
  constructor(readonly kind: GigaTransportFailure, message: string) {
    super(message);
    this.name = 'GigaTransportError';
  }
}

const deadline = (timeoutMs: number | undefined, fallback: number): number =>
  timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.ceil(timeoutMs), MAX_TIMER_MS) : fallback;

/** Options for `https.request`: the client certificate authenticates the request, there is no Authorization header. */
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

/**
 * The gateway does not stream: its socket is silent for the whole generation, so an idle limit shorter than the caller's
 * deadline would cut a long answer. One deadline therefore bounds the exchange, and the socket's idle limit is that same
 * deadline, never less. `defaults.timeoutMs` applies only when a request names none.
 */
export function createGigaTransport(config: GigaConfig, defaults: { timeoutMs?: number; maxResponseBytes?: number } = {}): GigaTransport {
  const fallback = deadline(defaults.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = defaults.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return (path, body, options = {}) => new Promise((resolve, reject) => {
    const { signal } = options;
    // addEventListener('abort', ...) below only fires on a FUTURE abort; a signal that is already aborted would
    // otherwise send the request anyway and wait for a response that never comes.
    if (signal?.aborted) { reject(new GigaTransportError('aborted', 'Giga request aborted')); return; }
    const timeoutMs = deadline(options.timeoutMs, fallback);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const timedOut = () => new GigaTransportError('timeout', `Giga gateway did not answer within ${timeoutMs % 1000 ? `${timeoutMs} ms` : `${timeoutMs / 1000} s`}`);
    const tooLarge = () => new GigaTransportError('too large', `Giga gateway response exceeds ${maxBytes} bytes`);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const abort = () => fail(new GigaTransportError('aborted', 'Giga request aborted'));
    /** The first outcome wins: a late 'error' after a refusal, or a timer after the answer, changes nothing. */
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      outcome();
    };
    const fail = (error: Error) => { settle(() => reject(error)); req.destroy(error); };
    const req = httpsRequest(requestOptions(config, path, payload, timeoutMs), response => {
      if (Number(response.headers['content-length']) > maxBytes) { fail(tooLarge()); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) fail(tooLarge());
        else chunks.push(chunk);
      });
      response.on('end', () => settle(() => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })));
      // Without this, a connection cut mid-body (proxy reset, truncated gateway response) leaves the promise pending
      // forever: 'end' never fires and 'req' has already succeeded.
      response.on('error', error => settle(() => reject(error)));
    });
    timer = setTimeout(() => fail(timedOut()), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => fail(timedOut()));
    req.on('error', error => settle(() => reject(error)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/*
 * Whose certificate failed. Node names a gateway certificate Lab could not verify by OpenSSL's X.509 verification result
 * (without a prefix) or by its own name check; it names a TLS alert the gateway sent about the owner's certificate by
 * the alert's OpenSSL reason (ERR_SSL_…_ALERT_…). The lists are exact: only the first kind may ever lead to the offer
 * to skip the check of the gateway's certificate.
 */

/** Which part of the gateway's own certificate did not verify: its chain of trust, its dates or its name. */
export type GatewayCertificateProblem = 'chain' | 'dates' | 'name';
const GATEWAY_CERTIFICATE: Record<GatewayCertificateProblem, readonly string[]> = {
  chain: ['UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'INVALID_CA', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE',
    'CERT_SIGNATURE_FAILURE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_REVOKED',
    'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'CRL_SIGNATURE_FAILURE', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD'],
  dates: ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD'],
  name: ['ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH'],
};
const GATEWAY_CERTIFICATE_CODES = new Map(Object.entries(GATEWAY_CERTIFICATE)
  .flatMap(([problem, codes]) => codes.map(code => [code, problem as GatewayCertificateProblem] as const)));

/** The problem with the gateway's own certificate a Node error code names; nothing for any other code. */
export const gatewayCertificateProblem = (code: string): GatewayCertificateProblem | undefined => GATEWAY_CERTIFICATE_CODES.get(code);

/** TLS alert descriptions (RFC 8446, 6.2) a server sends about the certificate its client presented. */
export const CLIENT_CERTIFICATE_ALERT = {
  noCertificate: 41, badCertificate: 42, unsupportedCertificate: 43, certificateRevoked: 44, certificateExpired: 45,
  certificateUnknown: 46, unknownCa: 48, accessDenied: 49, certificateRequired: 116,
} as const;
const CLIENT_CERTIFICATE_ALERTS: ReadonlySet<number> = new Set(Object.values(CLIENT_CERTIFICATE_ALERT));

/**
 * The alerts Node names by code. OpenSSL renamed its «sslv3 alert …» reasons to «ssl/tls alert …» (3.2), so both
 * spellings reach Node's codes, depending on the OpenSSL a Node release carries.
 */
const ALERT_CODES: ReadonlyMap<string, number> = new Map([
  ...(['SSLV3', 'SSL/TLS'] as const).flatMap(prefix => [
    [`ERR_SSL_${prefix}_ALERT_NO_CERTIFICATE`, CLIENT_CERTIFICATE_ALERT.noCertificate],
    [`ERR_SSL_${prefix}_ALERT_BAD_CERTIFICATE`, CLIENT_CERTIFICATE_ALERT.badCertificate],
    [`ERR_SSL_${prefix}_ALERT_UNSUPPORTED_CERTIFICATE`, CLIENT_CERTIFICATE_ALERT.unsupportedCertificate],
    [`ERR_SSL_${prefix}_ALERT_CERTIFICATE_REVOKED`, CLIENT_CERTIFICATE_ALERT.certificateRevoked],
    [`ERR_SSL_${prefix}_ALERT_CERTIFICATE_EXPIRED`, CLIENT_CERTIFICATE_ALERT.certificateExpired],
    [`ERR_SSL_${prefix}_ALERT_CERTIFICATE_UNKNOWN`, CLIENT_CERTIFICATE_ALERT.certificateUnknown],
  ] as const),
  ['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', CLIENT_CERTIFICATE_ALERT.unknownCa],
  ['ERR_SSL_TLSV1_ALERT_ACCESS_DENIED', CLIENT_CERTIFICATE_ALERT.accessDenied],
  ['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', CLIENT_CERTIFICATE_ALERT.certificateRequired],
]);

/** OpenSSL's library number of its SSL errors, and the offset of the reasons that carry a received alert. */
const OPENSSL_SSL_LIBRARY = 20;
const ALERT_REASON_OFFSET = 1000;

/**
 * The alert a TLS 1.2 handshake failed on. There Node reports only EPROTO, and the alert is known from the OpenSSL error
 * record its message carries (`…:error:0A000415:SSL routines:…`): the record's packed code is library << 23 | reason,
 * and a received alert's reason is its description plus 1000. The packed code is machine data, read as such.
 */
function recordedAlert(message: string): number | undefined {
  const fields = message.split(':');
  const at = fields.indexOf('error');
  const packed = at < 0 ? undefined : fields[at + 1];
  if (!packed || !/^[0-9A-F]{8}$/i.test(packed)) return undefined;
  const code = Number.parseInt(packed, 16);
  const reason = code & 0x7fffff;
  return (code >>> 23) === OPENSSL_SSL_LIBRARY && reason > ALERT_REASON_OFFSET && reason < ALERT_REASON_OFFSET + 256 ? reason - ALERT_REASON_OFFSET : undefined;
}

/** The alert the gateway refused the owner's certificate with, when a failed request carries one. */
export function clientCertificateAlert(error: unknown): number | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const alert = code === undefined ? undefined : ALERT_CODES.get(code) ?? (code === 'EPROTO' && error instanceof Error ? recordedAlert(error.message) : undefined);
  return alert !== undefined && CLIENT_CERTIFICATE_ALERTS.has(alert) ? alert : undefined;
}

/**
 * Which of the owner's files TLS cannot take, read exactly the way the transport hands them over. Checked only to
 * explain a connection that already failed, never to refuse one; nothing when every file is usable.
 */
export function unusableFile(config: GigaConfig): 'certificate' | 'key' | 'ca' | undefined {
  try { createSecureContext({ cert: config.cert }); } catch { return 'certificate'; }
  try { createSecureContext({ key: config.key }); } catch { return 'key'; }
  // A CA file that is not a certificate is ignored by TLS without a word; the gateway's chain would then not verify.
  if (config.ca) {
    try { new X509Certificate(config.ca); } catch { return 'ca'; }
  }
  return undefined;
}

/** False when the key is not the certificate's own: Node then quietly sends the gateway no certificate at all. */
export function keyMatchesCertificate(config: GigaConfig): boolean {
  try { return new X509Certificate(config.cert).checkPrivateKey(createPrivateKey(config.key)); } catch { return true; }
}
