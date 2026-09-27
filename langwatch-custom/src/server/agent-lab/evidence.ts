import type { Source, Rule } from './schema';

/** Prefer explicit role envelopes; retain the bank export's inline uppercase format as a legacy input. */
export function messages(text: string): { role: 'user' | 'assistant'; content: string }[] {
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.messages;
    if (Array.isArray(rows)) return rows.flatMap(row => {
      const role = row.role === 'user' || row.role === 'CLIENT' ? 'user' : row.role === 'assistant' || row.role === 'AGENT' ? 'assistant' : undefined;
      return role && typeof row.content === 'string' ? [{ role, content: row.content } as const] : [];
    });
  } catch { /* A text export, not a JSON envelope. */ }
  const lines = [...text.matchAll(/^(CLIENT|AGENT|USER|ASSISTANT)\s*:\s*/gm)];
  const markers = lines.length > 1 ? lines : [...text.matchAll(/\b(CLIENT|AGENT)\b(?::\s*)?/g)];
  return markers.map((marker, index) => ({
    role: marker[1] === 'CLIENT' || marker[1] === 'USER' ? 'user' : 'assistant',
    content: text.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? text.length).trim(),
  }));
}

const words = (text: string) => new Set(text.normalize('NFKC').toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{4,}/gu) ?? []);

/** Retrieval proposes additional context. Every cited source and prompt is always present in full. */
export function evidenceSources(sources: Source[], query: string, rules: Rule[] = []): Source[] {
  const required = new Set(rules.map(rule => rule.sourceId));
  for (const rule of rules) {
    const source = sources.find(source => source.id === rule.sourceId);
    if (!source?.content.includes(rule.quote)) throw new Error('Источник проверяемого правила отсутствует или изменился: ' + rule.id);
  }
  const pinned = sources.filter(source => source.kind === 'prompt' || required.has(source.id));
  const wanted = words(query);
  const extra = sources.filter(source => !pinned.includes(source)).map(source => ({ source,
    score: [...words(source.name + ' ' + source.content)].filter(word => wanted.has(word)).length,
  })).filter(item => item.score > 0).sort((a,b) => b.score - a.score).slice(0,7).map(({source}) => {
    if (source.content.length <= 6000) return source;
    const parts = source.content.split(/\n\s*\n/);
    const content = parts.map((part,index) => ({part,index,score:[...words(part)].filter(word=>wanted.has(word)).length}))
      .sort((a,b)=>b.score-a.score).slice(0,3).sort((a,b)=>a.index-b.index).map(item=>item.part).join('\n\n');
    return {...source,content};
  });
  return [...pinned, ...extra];
}

/** The native simulator gets customer facts; the native judge receives the rule and its evidence separately. */
export function criterionText(rule: Rule, sources: Source[]): string {
  const source = sources.find(source => source.id === rule.sourceId);
  if (!source?.content.includes(rule.quote)) throw new Error('Нет дословного основания правила ' + rule.id);
  return [rule.text, 'Условие: ' + rule.condition, 'Допустимые ответы: ' + rule.acceptable,
    'Основание («' + source.name + '»): «' + rule.quote + '»',
    'Оценивайте только применимое правило. Недостаток доказательств не является доказанной ошибкой агента.'].join('\n');
}
