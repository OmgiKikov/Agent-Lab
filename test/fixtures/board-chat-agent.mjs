// Test fixture for the chat tests: a module agent that always asks for the terminal number.
// While the file named by AGENT_LAB_TEST_HOLD exists, every reply waits, so a test can watch a run in progress.
import { existsSync } from 'node:fs';

export function createSession({ initialState }) {
  return { async respond() {
    const hold = process.env.AGENT_LAB_TEST_HOLD;
    while (hold && existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 20));
    return { reply: 'Уточните номер терминала', records: initialState.records, resetConfirmed: true, eventsComplete: true };
  } };
}
