import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function openBrowser(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Unsafe browser URL.');
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Open the displayed URL in your browser.')));
  });
}
export async function listenCallback({ state, timeoutMs = 300000 }) {
  let finish, reject, timer, consumed = false;
  const waitForCode = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
  // Avoid an unhandled timeout if browser startup fails before the caller awaits this promise.
  waitForCode.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { response.writeHead(400).end('Invalid callback.'); return; }
    const supplied = url.searchParams.get('state');
    const suppliedBytes = Buffer.from(supplied ?? ''), stateBytes = Buffer.from(state);
    if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${server.address().port}` || url.pathname !== '/oauth/callback' || request.url.length > 8192 || consumed || !supplied || suppliedBytes.length !== stateBytes.length || !timingSafeEqual(suppliedBytes, stateBytes) || ['state', 'code', 'iss', 'error'].some(name => url.searchParams.getAll(name).length > 1)) { response.writeHead(400).end('Invalid or expired connection callback.'); return; }
    consumed = true; clearTimeout(timer);
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('You can return to Flusso Listener. This page does not contain your credentials.');
    finish({ code: url.searchParams.get('code'), state: supplied, issuer: url.searchParams.get('iss'), iss: url.searchParams.get('iss'), error: url.searchParams.get('error') });
    server.close();
  });
  await new Promise((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolve); });
  timer = setTimeout(() => { server.close(); reject(new Error('Browser connection timed out. Start Connect again.')); }, timeoutMs);
  return { redirectUri: `http://127.0.0.1:${server.address().port}/oauth/callback`, waitForCode, close() { clearTimeout(timer); server.close(); if (!consumed) { consumed = true; reject(new Error('Browser connection closed.')); } } };
}
