export function trustedFrame(event, window, origin) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/' && !url.search; } catch { return false; }
}
export function externalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'flusso.stream') throw new Error('External navigation refused.');
  return url.href;
}
