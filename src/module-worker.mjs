import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Console } from 'node:console';

// One process per dialogue also clears the import cache between agent versions.
// The protocol has a pipe of its own (fd 3): whatever the module writes — console, process.stdout — is diagnostics Lab
// keeps, never an answer. Messages here reach the owner as the reason a dialogue was not measured, so they are in Russian.
globalThis.console = new Console(process.stderr);
const protocol = new Socket({ fd: 3, readable: false, writable: true });
/** One JSON line answers one request; a module that returns nothing answers null, which Lab reads as a reply outside its contract. */
const answer = value => new Promise((resolve, reject) => protocol.write(`${JSON.stringify(value ?? null)}\n`, error => error ? reject(error) : resolve()));
let session;
try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  const factory = mod[process.argv[3]];
  if (typeof factory !== 'function') throw new Error(`В модуле агента нет функции ${process.argv[3]}: проверьте exportName в подключении.`);
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.type === 'open') {
      session = await factory({ sessionId: request.sessionId, scenarioId: request.scenarioId, initialState: request.initialState, diagnosticRequest: request.diagnosticRequest, prompt: request.prompt, promptHash: request.promptHash });
      if (typeof session?.respond !== 'function') throw new Error(`Функция ${process.argv[3]} модуля агента должна вернуть сессию с методом respond(message, messages).`);
      await answer('');
    } else if (request.type === 'close') break;
    else if (request.type === 'respond' && session) await answer(await session.respond(request.message, request.messages, request.choice));
    else throw new Error('Модуль агента получил сообщение, которого нет в протоколе Lab.');
  }
  await session?.close?.();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
}
