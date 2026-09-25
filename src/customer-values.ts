import { createHash } from 'node:crypto';
import { placeholderSpans, withValues } from './masking.js';

/*
 * What the customer Lab plays says where its card kept a masking mark of the log. A de-identified export writes marks
 * over what a customer typed («Номер карты: [НОМЕР_КАРТЫ]»); a card may keep one in what its customer knows, and a
 * customer that sends it gives the agent words no customer writes — the agent then fails through no fault of its own.
 * Every message goes to the agent with each mark replaced by a synthetic value of the mark's kind, the same value for the
 * same mark all through the conversation, recorded in the trial so the judge and the owner see what was sent:
 *
 *   «Карта [НОМЕР_КАРТЫ]» ─► «Карта 2200 4817 3950 1286»      a Luhn-valid card number, a phone, an account, a name …
 *
 * The kind is read from the mark's own words by a fixed table (a tag is a structural token, like an id); a mark that
 * names no kind (***, [скрыто]) gets a number. Values are derived from the conversation's id, so a record replays alike.
 * Never real data: card numbers start with a test prefix, e-mails live at example.com.
 */

export const VALUE_KINDS = ['card', 'phone', 'account', 'inn', 'email', 'name', 'date', 'address', 'number'] as const;
export type ValueKind = typeof VALUE_KINDS[number];

/** The words of a mark that name its kind, in the order they are tried: «НОМЕР_ТЕЛЕФОНА» is a phone, «НОМЕР_КАРТЫ» a card. */
const KIND_WORDS: readonly (readonly [ValueKind, readonly string[]])[] = [
  ['card', ['КАРТА', 'КАРТЫ', 'КАРТЕ', 'CARD', 'PAN']],
  ['phone', ['ТЕЛЕФОН', 'ТЕЛЕФОНА', 'PHONE', 'TEL', 'MOBILE', 'МОБИЛЬНЫЙ']],
  ['account', ['СЧЕТ', 'СЧЁТ', 'СЧЕТА', 'СЧЁТА', 'ACCOUNT']],
  ['inn', ['ИНН', 'INN']],
  ['email', ['EMAIL', 'E-MAIL', 'MAIL', 'ПОЧТА']],
  ['name', ['ФИО', 'FIO', 'NAME', 'ИМЯ', 'ФАМИЛИЯ']],
  ['date', ['ДАТА', 'DATE']],
  ['address', ['АДРЕС', 'ADDRESS']],
];
const NAMES = ['Ирина Смирнова', 'Алексей Иванов', 'Ольга Кузнецова', 'Дмитрий Попов', 'Елена Соколова', 'Сергей Лебедев', 'Анна Морозова', 'Павел Волков'];
const ADDRESSES = ['г. Москва, ул. Лесная, д. 12, кв. 45', 'г. Казань, ул. Баумана, д. 7, кв. 3', 'г. Новосибирск, ул. Кирова, д. 28, кв. 91', 'г. Самара, ул. Садовая, д. 5, кв. 17'];

/** The kind a mark names by its words; `number` when it names none. */
export function markKind(mark: string): ValueKind {
  const words = mark.toUpperCase().split('').map(char => char.toLowerCase() === char.toUpperCase() && (char < '0' || char > '9') && char !== '-' ? ' ' : char).join('').split(' ').filter(Boolean);
  return KIND_WORDS.find(([, names]) => words.some(word => names.includes(word)))?.[0] ?? 'number';
}

/** Decimal digits drawn from `seed`, as many as asked. */
function digits(seed: string, count: number): string {
  let out = '';
  for (let round = 0; out.length < count; round++) out += BigInt(`0x${createHash('sha256').update(`${seed}|${round}`).digest('hex')}`).toString().slice(1);
  return out.slice(0, count);
}
/** The Luhn check digit of a card number's other digits. */
function luhn(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let digit = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return String((10 - sum % 10) % 10);
}
/** A personal INN: ten digits and its two check digits. */
function inn(body: string): string {
  const check = (value: string, weights: number[]) => String(weights.reduce((sum, weight, i) => sum + weight * Number(value[i]), 0) % 11 % 10);
  const eleven = body + check(body, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return eleven + check(eleven, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
}
const pad = (n: number) => String(n).padStart(2, '0');

/** A synthetic value of `kind`, derived from `seed`: the same seed, the same value. */
export function syntheticValue(kind: ValueKind, seed: string): string {
  const d = digits(seed, 24);
  switch (kind) {
    case 'card': { const number = `2200${d.slice(0, 11)}`; return (number + luhn(number)).match(/\d{4}/g)!.join(' '); }
    case 'phone': return `+7 9${d.slice(0, 2)} ${d.slice(2, 5)}-${d.slice(5, 7)}-${d.slice(7, 9)}`;
    case 'account': return `40817810${d.slice(0, 12)}`;
    case 'inn': return inn(`7${d.slice(0, 9)}`);
    case 'email': return `client${d.slice(0, 5)}@example.com`;
    case 'name': return NAMES[Number(d.slice(0, 4)) % NAMES.length]!;
    case 'address': return ADDRESSES[Number(d.slice(0, 4)) % ADDRESSES.length]!;
    case 'date': { const day = new Date(Date.UTC(2025, 0, 1) + Number(d.slice(0, 3)) % 360 * 86_400_000); return `${pad(day.getUTCDate())}.${pad(day.getUTCMonth() + 1)}.${day.getUTCFullYear()}`; }
    case 'number': return String(100000 + Number(d.slice(0, 6)) % 900000);
  }
}

/** One value the customer sent in place of a mark. */
export interface SyntheticValue { mark: string; kind: ValueKind; value: string }

/**
 * The values of one conversation: `deliver` writes each mark of a message over with its value — the same mark, the same
 * value, all through the conversation — and says which it used; `used` lists every one sent so far.
 */
export function conversationValues(conversation: string): { deliver(message: string): { text: string; used: SyntheticValue[] }; used: SyntheticValue[] } {
  const known = new Map<string, SyntheticValue>();
  const used: SyntheticValue[] = [];
  return {
    used,
    deliver(message) {
      const spans = placeholderSpans(message);
      if (!spans.length) return { text: message, used: [] };
      const here = spans.map(span => {
        const key = span.mark.toUpperCase();
        let value = known.get(key);
        if (!value) {
          const kind = markKind(span.mark);
          value = { mark: span.mark, kind, value: syntheticValue(kind, `${conversation}|${key}`) };
          known.set(key, value); used.push(value);
        }
        return value;
      });
      return { text: withValues(message, spans.map((span, i) => ({ start: span.start, end: span.end, value: here[i]!.value }))), used: [...new Set(here)] };
    },
  };
}
