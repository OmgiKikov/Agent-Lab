import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Settings } from '../contracts.js';
import type { Model } from './model-call.js';

/*
 * Which model answers each role, resolved and checked once, before the first paid call:
 *
 *   builder   = roles.builder   ?? the run's model
 *   simulator = roles.simulator ?? the run's model
 *   judge     = roles.judge     ?? settings.judge ?? the run's model
 *
 * A judge on OpenRouter goes through the Chat Completions adapter, for every judge-role task (rubric votes,
 * votes on logged conversations, the card review): routing options such as a pinned upstream belong to that
 * adapter, and the catalog would otherwise pick a vendor-native endpoint that ignores them.
 */

export type ModelRole = 'builder' | 'judge' | 'simulator';
export const AUTH_HELP = 'Войдите в Pi через /login или задайте ключ выбранного провайдера, затем выберите доступную модель. Живой прогон никогда не подменяется демо.';

/** The model of every role, and what the judge's transport promises (recorded in every judge receipt). */
export type ModelTable = Readonly<Record<ModelRole, Model>> & {
  readonly judgeTransport: { api: string; upstream?: string; structured: boolean };
};

type Choice = { provider: string; model: string };

function configured(runtime: ModelRuntime, choice: Choice): Model {
  const model = runtime.getModel(choice.provider, choice.model);
  if (model) return model;
  const joined = `${choice.provider}/${choice.model}`;
  const suggested = runtime.getModels().find(candidate => `${candidate.provider}/${candidate.id}` === joined || `${candidate.provider}/${candidate.id}` === choice.provider);
  throw new Error(`Модель не найдена в конфигурации Pi: provider=${choice.provider}, model=${choice.model}.${suggested
    ? ` Укажите provider="${suggested.provider}", model="${suggested.id}"; это разные поля.`
    : ' Прочитайте доступные модели через agent-lab status и выберите точную пару provider/model.'}`);
}

/** The OpenRouter Chat Completions adapter of a catalog model, pinned to one upstream when one is named. */
function openRouterChat(model: Model, upstream: string | undefined): Model {
  return { ...model, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
    compat: { ...model.compat, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
      ...(upstream ? { openRouterRouting: { only: [upstream], allow_fallbacks: false } } : {}) } };
}

/** OpenRouter honours the provider-native JSON mode; other transports get the output contract in the prompt only. */
export const jsonMode = (model: Model): Record<string, unknown> | undefined => model.provider === 'openrouter' ? { type: 'json_object' } : undefined;

/**
 * Resolves every role and checks its access before any paid call, so a typo in the judge fails before the builder
 * spends anything. The run's own model is always checked; a role override is named in its own error.
 */
export async function resolveModels(runtime: ModelRuntime, settings: Settings, signal: AbortSignal): Promise<ModelTable> {
  if (!settings.provider || !settings.model) throw new Error(`Выберите провайдера и модель. ${AUTH_HELP}`);
  const listed = new Map<string, readonly Model[]>();
  const available = async (choice: Choice, unreadable: string, missing: string): Promise<Model> => {
    const model = configured(runtime, choice);
    let models = listed.get(choice.provider);
    if (!models) {
      try { models = await runtime.getAvailable(choice.provider, { signal }); }
      catch { throw new Error(unreadable); }
      listed.set(choice.provider, models);
    }
    if (!models.some(candidate => candidate.id === model.id)) throw new Error(missing);
    return model;
  };
  const main = await available({ provider: settings.provider, model: settings.model }, `Не удалось проверить доступ к моделям. ${AUTH_HELP}`, AUTH_HELP);
  const role = (choice: Choice | undefined) => choice
    ? available(choice, `Не удалось проверить доступ к модели роли ${choice.provider}/${choice.model}. ${AUTH_HELP}`, `Модель роли недоступна: ${choice.provider}/${choice.model}. ${AUTH_HELP}`)
    : main;
  const builder = await role(settings.roles?.builder);
  const simulator = await role(settings.roles?.simulator);
  const judge = await role(settings.roles?.judge ?? settings.judge);
  // An upstream is a routing preference of the configured judge; a judge chosen by role override names none.
  const upstream = settings.roles?.judge ? undefined : settings.judge?.upstream;
  const openRouter = judge.provider === 'openrouter';
  const judgeModel = openRouter ? openRouterChat(judge, upstream) : judge;
  return {
    builder, simulator, judge: judgeModel,
    judgeTransport: { api: judgeModel.api, ...(upstream ? { upstream } : {}), structured: openRouter },
  };
}
