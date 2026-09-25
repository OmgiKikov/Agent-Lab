import type { ImportBatch } from './scenario-contracts.js';

/*
 * Personal data a log still holds in the open, found by its structural shape only: card numbers (13–19 digits that
 * pass the Luhn check), Russian phone numbers (+7 or 8 and ten digits, or ten digits of a mobile number, with the
 * usual separators) and e-mail addresses. Nothing is masked here: the owner decides whether logs go to the model's
 * provider as they are, and the consent of a preparation tells them what is there (miner/plan.ts). Names, passports
 * and addresses have no shape to find without reading the words, so they are never claimed found or absent.
 */

/** A run of 13–19 digits, single spaces or hyphens between them, not touching another digit. */
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
/** A run of digits and phone separators that starts with a digit or +, not touching another digit. */
const PHONE = /(?<![\d+])\+?\d[\d ()\-.]{8,18}\d(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** The Luhn check card numbers carry in their last digit. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

const digitsOf = (text: string): string => [...text].filter(char => char >= '0' && char <= '9').join('');
/** A Russian phone number: +7 or 8 (or 7) and ten digits, or the ten digits of a mobile number alone. */
const phone = (text: string): boolean => {
  const digits = digitsOf(text);
  return digits.length === 11 ? digits[0] === '7' || digits[0] === '8' : digits.length === 10 && digits[0] === '9' && !text.startsWith('+');
};

/** Which shapes of personal data one text holds. */
export function personalShapes(text: string): { card: boolean; phone: boolean; email: boolean } {
  return {
    card: [...text.matchAll(CARD)].some(match => luhn(digitsOf(match[0]))),
    phone: [...text.matchAll(PHONE)].some(match => phone(match[0])),
    email: EMAIL.test(text),
  };
}

/** Conversations of an import holding each shape in the open, and those holding any: what goes to the provider as it is. */
export interface PersonalData { conversations: number; cards: number; phones: number; emails: number }

/** Every conversation of the import, every text it holds — the customer's and the agent's: both reach the model's provider. */
export function personalData(batch: Pick<ImportBatch, 'dialogues'>): PersonalData {
  const found: PersonalData = { conversations: 0, cards: 0, phones: 0, emails: 0 };
  for (const dialogue of batch.dialogues) {
    const shapes = { card: false, phone: false, email: false };
    for (const event of dialogue.events) {
      if (event.content === undefined) continue;
      const own = personalShapes(event.content);
      shapes.card ||= own.card; shapes.phone ||= own.phone; shapes.email ||= own.email;
    }
    if (shapes.card) found.cards++;
    if (shapes.phone) found.phones++;
    if (shapes.email) found.emails++;
    if (shapes.card || shapes.phone || shapes.email) found.conversations++;
  }
  return found;
}
