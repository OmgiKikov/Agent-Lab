import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Same-origin local bridge. No key in the browser, no new CSP origin. */
export async function handleLocalReview(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const prefix = '/api/local-review';
  const path = (req.url ?? '').split('?')[0]!;
  if (!path.startsWith(prefix + '/')) return false;
  const host = req.headers.host ?? '';
  const origin = `http://${host}`;
  const allowed = new Set(['http://localhost:5560', 'http://127.0.0.1:5560']);
  const peer = req.socket.remoteAddress;
  if (!allowed.has(origin) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') ||
      (req.headers.origin && req.headers.origin !== origin)) {
    res.statusCode = 403;
    res.end(JSON.stringify({error: 'Доступно только в локальном LangWatch'}));
    return true;
  }
  await new Promise<void>((resolve) => {
    const upstream = request({hostname: '127.0.0.1', port: 11436, method: req.method,
      path: path.slice(prefix.length), headers: {'Content-Type': 'application/json', Origin: origin,
      Cookie: req.headers.cookie ?? '', ...(req.headers['content-length'] ? {'Content-Length': req.headers['content-length']} : {})}}, response => {
      res.statusCode = response.statusCode ?? 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      response.pipe(res);
      response.on('end', resolve);
    });
    const failure = () => { if(!res.headersSent) {res.statusCode=502;res.setHeader('Content-Type','application/json');}
      if(!res.writableEnded)res.end(JSON.stringify({error:'Сервис проверки недоступен. Запустите LangWatch заново.'}));resolve();};
    upstream.setTimeout(60000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', failure);
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  return true;
}
