import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Settings } from '../contracts.js';
import { GIGA_PROVIDER_ID } from '../giga-provider.js';
import type { Model } from './model-call.js';

/*
 * Which model answers each role, by the one rule every reader applies (roleChoices), checked once before the first paid call:
 *
 *   builder   = roles.builder   ?? the run's model
 *   simulator = roles.simulator ?? the run's model
 *   judge     = roles.judge     ?? settings.judge ?? the run's model
 *
 * A judge on OpenRouter goes through the Chat Completions adapter, for every judge-role task (rubric votes,
 * votes on logged conversations, the card review): routing options such as a pinned upstream belong to that
 * adapter, and the catalog would otherwise pick a vendor-native endpoint that ignores them.
 *
 * The judge's strict response schema reaches the wire where the transport honours it: OpenRouter's Chat Completions,
 * and the internal gateway (provider giga), which translates the same hook into its own model options.
 */

export type ModelRole = 'builder' | 'judge' | 'simulator';
/** The way to a model Pi can use, said wherever a model is missing — a preparation, a run, a status — on both surfaces. */
export const AUTH_HELP = 'Войдите в Pi (/login) или задайте ключ провайдера, затем выберите доступную модель: в чате — /model, в терминале — agent-lab status покажет модели, которые видит Pi.';
/** Each role's model as the owner calls it. */
const ROLE_WORDS: Readonly<Record<ModelRole, string>> = { builder: 'модель, которая готовит ситуации', simulator: 'модель, которая играет клиента', judge: 'модель судьи' };

/** The model of every role, and what the judge's transport promises (recorded in every judge receipt). */
export type ModelTable = Readonly<Record<ModelRole, Model>> & {
  readonly judgeTransport: { api: string; upstream?: string; structured: boolean };
};

/** A model as settings and judge receipts name it: the provider key and the model id within it. */
export type ModelChoice = { provider: string; model: string };
type Choice = ModelChoice;

/**
 * Which model answers each role — the rule every reader applies: the runtime before its first call, the judge
 * identity a comparison seals (normalize.ts), the gateway a runtime registers (pi.ts), the judge a result names and
 * whether it is the model that built the situations (result-view.ts). An explicit role wins; the judge then falls
 * back to the configured judge, every role to the run's own model. The judge's upstream is a routing preference of
 * the configured judge only: a judge chosen by role override names none. A record made before a field existed reads
 * it as absent.
 */
export function roleChoices(settings: Pick<Settings, 'provider' | 'model' | 'judge'> & { roles?: Partial<Settings['roles']> }):
  Readonly<Record<ModelRole, ModelChoice>> & { readonly judgeUpstream?: string } {
  const main = { provider: settings.provider ?? '', model: settings.model ?? '' };
  const roles = settings.roles ?? {};
  const judge = roles.judge ?? settings.judge;
  const upstream = roles.judge ? undefined : settings.judge?.upstream;
  return { builder: roles.builder ?? main, simulator: roles.simulator ?? main,
    judge: judge ? { provider: judge.provider, model: judge.model } : main, ...(upstream ? { judgeUpstream: upstream } : {}) };
}

function configured(runtime: ModelRuntime, choice: Choice): Model {
  const model = runtime.getModel(choice.provider, choice.model);
  if (model) return model;
  const joined = `${choice.provider}/${choice.model}`;
  const suggested = runtime.getModels().find(candidate => `${candidate.provider}/${candidate.id}` === joined || `${candidate.provider}/${candidate.id}` === choice.provider);
  throw new Error(suggested
    ? `Pi не знает модели «${joined}»: провайдер и модель записаны вместе. Укажите провайдера «${suggested.provider}» и модель «${suggested.id}» по отдельности.`
    : `Pi не знает модели «${joined}». Выберите модель из тех, что видит Pi: в чате — /model, в терминале — agent-lab status.`);
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
  const named = `${settings.provider}/${settings.model}`;
  const main = await available({ provider: settings.provider, model: settings.model }, `Не удалось проверить, доступна ли модель «${named}». ${AUTH_HELP}`,
    `Модель «${named}» недоступна с вашим входом в Pi. ${AUTH_HELP}`);
  const choices = roleChoices(settings);
  // A role that resolves to the run's own model is that model, checked once above; any other is named in its own error.
  const role = (name: ModelRole, choice: Choice) => choice.provider === settings.provider && choice.model === settings.model ? main
    : available(choice, `Не удалось проверить, доступна ли ${ROLE_WORDS[name]} «${choice.provider}/${choice.model}». ${AUTH_HELP}`,
      `Недоступна ${ROLE_WORDS[name]} «${choice.provider}/${choice.model}». ${AUTH_HELP}`);
  const builder = await role('builder', choices.builder);
  const simulator = await role('simulator', choices.simulator);
  const judge = await role('judge', choices.judge);
  const upstream = choices.judgeUpstream;
  const openRouter = judge.provider === 'openrouter';
  const judgeModel = openRouter ? openRouterChat(judge, upstream) : judge;
  return {
    builder, simulator, judge: judgeModel,
    judgeTransport: { api: judgeModel.api, ...(upstream ? { upstream } : {}), structured: openRouter || judge.provider === GIGA_PROVIDER_ID },
  };
}
