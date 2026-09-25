import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  connectGateway, forgetConnections, gatewayFailureText, GIGA_PROVIDER_ID, keepConnection, reconnectGateway, type GatewayConnection, type GatewayFailure,
} from '../src/giga-provider.js';
import {
  forgetGatewaySettings, gatewayEnvironment, gatewayFile, gatewaySettingsSchema, gatewayStatus, saveGatewaySettings, settingsEnvironment,
  unreadableGigaFiles,
} from '../src/giga-transport.js';
import { safeText } from '../src/text.js';

/*
 * The owner's personal model gateway (provider giga) inside Pi. It authenticates by a client certificate, so it
 * cannot be declared in models.json: the extension registers it itself, once at load (so its models are in the first
 * /model list) and again whenever the owner connects it with `/agent-lab gateway`. On a work machine the gateway is
 * often the only way to a model, so connecting it is a command with native dialogs and needs no model at all.
 *
 *   load ──► connect with the remembered paths (or AGENT_LAB_GATEWAY_*) ──► provider giga | a line in the start widget
 *   /agent-lab gateway ──► address, certificate, key, CA ──► catalog checked with exactly these files ──► paths saved, provider giga
 *   /agent-lab gateway off ──► confirmed ──► paths forgotten, provider removed
 *
 * Either connection is also the process's connection (src/giga-provider.ts): Lab's own runtimes reuse it instead of
 * asking the gateway again. Only paths are remembered (~/.agent-lab/gateway.json, 0600), never the files. The
 * configuration and the transport live in src/giga-*.ts; this module owns the dialogs.
 */

/** The owner's words for the gateway's variables. */
const FIELD_NAMES: Record<string, string> = {
  AGENT_LAB_GATEWAY_URL: 'адрес шлюза',
  AGENT_LAB_GATEWAY_CERT_PATH: 'сертификат',
  AGENT_LAB_GATEWAY_KEY_PATH: 'ключ',
  AGENT_LAB_GATEWAY_CA_PATH: 'цепочка CA',
};
export const fieldNames = (variables: readonly string[]): string => variables.map(name => FIELD_NAMES[name] ?? name).join(', ');

/** `~/…` and relative paths are written the way the owner sees them in a terminal; an absolute path is remembered. */
export function ownerPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(1));
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface GatewayInput { url: string; certPath: string; keyPath: string; caPath?: string | undefined; insecure?: boolean }
/** One attempt to connect with what the owner typed: connected and saved, or refused with the reason, when the gateway gave one. */
type Attempt = { connected: true; message: string } | { connected: false; message: string; failure?: GatewayFailure };

export interface GatewayOptions {
  /** The file of the remembered paths; ~/.agent-lab/gateway.json (or AGENT_LAB_GATEWAY_FILE) by default. */
  file?: string;
  /** How the gateway is reached; tests pass their own. */
  connect?: typeof connectGateway;
}

/** The gateway of one Pi session: its startup connection, the line for the start widget and the `/agent-lab gateway` command. */
export interface Gateway {
  /** Resolves once the startup connection is settled; never rejects, a refusal becomes `note()`. */
  readonly ready: Promise<void>;
  /** What the owner should know at start when the gateway did not connect; nothing when it did or was never set up. */
  note(): string | undefined;
  command(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export function createGateway(pi: Pick<ExtensionAPI, 'registerProvider' | 'unregisterProvider'>, options: GatewayOptions = {}): Gateway {
  const file = options.file ?? gatewayFile();
  const connect = options.connect ?? connectGateway;
  let models: string[] | undefined;
  let note: string | undefined;
  const connected = (connection: Extract<GatewayConnection, { provider: unknown }>) => {
    pi.registerProvider(GIGA_PROVIDER_ID, connection.provider);
    models = connection.models; note = undefined;
  };
  const ready = (async () => {
    try {
      const connection = await reconnectGateway(gatewayEnvironment(process.env, file), connect);
      if ('provider' in connection) connected(connection);
      else if (connection.failure.kind !== 'not configured') note = `Шлюз моделей не подключился: ${gatewayFailureText(connection.failure)} /agent-lab gateway настроит его заново.`;
    } catch { note = 'Личная настройка шлюза моделей повреждена. /agent-lab gateway настроит его заново.'; }
  })();

  /** Checks access with exactly these files and only then remembers the paths and connects the provider. */
  const remember = async (input: GatewayInput, cwd: string, signal?: AbortSignal): Promise<Attempt> => {
    const parsed = gatewaySettingsSchema.safeParse({ format: 'agent-lab-gateway-1', url: input.url.trim(), certPath: ownerPath(input.certPath, cwd),
      keyPath: ownerPath(input.keyPath, cwd), ...(input.caPath ? { caPath: ownerPath(input.caPath, cwd) } : {}), ...(input.insecure ? { insecure: true } : {}) });
    if (!parsed.success) return { connected: false, message: 'Адрес шлюза не похож на адрес: нужен вид https://шлюз.' };
    const env = settingsEnvironment(parsed.data);
    const unreadable = unreadableGigaFiles(env);
    if (unreadable.length) return { connected: false, message: `Не читается: ${fieldNames(unreadable)}. Проверьте путь.` };
    const connection = await connect(env, undefined, signal);
    if (!('provider' in connection)) {
      return { connected: false, failure: connection.failure, message: `Шлюз не подключён, ничего не сохранено: ${gatewayFailureText(connection.failure)}` };
    }
    await saveGatewaySettings(parsed.data, file);
    keepConnection(env, connection);
    connected(connection);
    return { connected: true, message: `Шлюз моделей подключён: моделей ${connection.models.length}. Выберите модель: /model → giga.${parsed.data.insecure ? ' Сертификат самого шлюза не проверяется — по вашему решению.' : ''}` };
  };

  const setup = async (ctx: ExtensionCommandContext): Promise<void> => {
    const url = (await ctx.ui.input('Адрес шлюза моделей', 'https://…'))?.trim();
    if (!url) return;
    const certPath = (await ctx.ui.input('Путь к вашему сертификату', '~/certs/tls.cer'))?.trim();
    if (!certPath) return;
    const keyPath = (await ctx.ui.input('Путь к вашему ключу', '~/certs/tls.key'))?.trim();
    if (!keyPath) return;
    const caPath = (await ctx.ui.input('Путь к цепочке CA шлюза (Enter — пропустить)', ''))?.trim() || undefined;
    let result = await remember({ url, certPath, keyPath, caPath }, ctx.cwd, ctx.signal);
    // Skipping the check is offered only when the gateway's own certificate did not verify: a refusal of the owner's
    // certificate is fixed with the owner's files, and weakening TLS would not help it.
    if (!result.connected && result.failure?.kind === 'gateway certificate' && await ctx.ui.confirm('Сертификат шлюза не проверяется',
      `${sentence(gatewayFailureText(result.failure))} Подключиться без проверки сертификата самого шлюза? Ваш сертификат при этом по-прежнему нужен. Решение запомнится.`)) {
      result = await remember({ url, certPath, keyPath, caPath, insecure: true }, ctx.cwd, ctx.signal);
    }
    ctx.ui.notify(safeText(result.message), result.connected ? 'info' : 'error');
    if (result.connected) ctx.ui.setWidget('agent-lab-start', undefined);
  };

  const forget = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!await ctx.ui.confirm('Отключить шлюз моделей?', 'Lab забудет пути к вашим сертификату и ключу. Сами файлы не удаляются.')) return;
    const removed = await forgetGatewaySettings(file);
    pi.unregisterProvider(GIGA_PROVIDER_ID); models = undefined;
    forgetConnections();
    const environment = Object.keys(process.env).some(name => name.startsWith('AGENT_LAB_GATEWAY_') && name !== 'AGENT_LAB_GATEWAY_FILE' && process.env[name]);
    ctx.ui.notify(`${removed ? 'Шлюз моделей отключён: пути забыты, модели giga убраны из выбора.' : 'Личной настройки шлюза не было; модели giga убраны из выбора.'}${environment
      ? ' Переменные AGENT_LAB_GATEWAY_* всё ещё заданы: в следующем запуске шлюз подключится по ним.' : ''}`, 'info');
  };

  return {
    ready,
    note: () => note,
    async command(args, ctx) {
      if (args === 'off') return forget(ctx);
      const status = gatewayStatus({ ...process.env, AGENT_LAB_GATEWAY_FILE: file });
      if (!models?.length && !status.configured) return setup(ctx);
      const state = models?.length ? `Шлюз моделей подключён: моделей ${models.length}.` : status.settingsError
        ? 'Личная настройка шлюза повреждена.' : `Шлюз настроен, но в этом разговоре не подключился.${note ? ` ${note}` : ''}`;
      const unreadable = status.unreadableFiles.length ? ` Не читается: ${fieldNames(status.unreadableFiles)}.` : '';
      const choice = await ctx.ui.select(safeText(`${state}${unreadable}`), ['Подключить заново', 'Отключить шлюз', 'Оставить как есть']);
      if (choice === 'Подключить заново') await setup(ctx);
      else if (choice === 'Отключить шлюз') await forget(ctx);
    },
  };
}
