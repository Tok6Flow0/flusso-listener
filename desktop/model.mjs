import { readFile, mkdir, writeFile, unlink, copyFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { MODEL, classificationMessages, decisionSchema, readClassificationStream, modelUnavailable } from '../src/model.mjs';
import { verifiedDownload, verifiedFile } from './download.mjs';

const resources = JSON.parse(await readFile(new URL('./resources.json', import.meta.url)));
export function createDesktopModel({ directory, runtimeDirectory, existingModelPath, onChange = () => {} }) {
  // Trusted offline callers may reuse the installed weights without copying them.
  // This option is never read from a note, renderer request, or desktop settings.
  if (existingModelPath !== undefined && (typeof existingModelPath !== 'string' || !isAbsolute(existingModelPath))) throw new TypeError('Use an absolute existing model path.');
  const resource = resources.model, modelPath = existingModelPath ?? join(directory, 'models', resource.filename);
  const lifetime = new AbortController();
  let readyOnce = false, state = { state: 'missing', phase: 'setup', message: 'The local model is not set up for research reviews.' }, pending, child, endpoint, apiKey, stopping = false;
  const publish = value => { state = { phase: readyOnce ? 'runtime' : 'setup', ...value }; onChange({ ...state }); };
  async function start() {
    lifetime.signal.throwIfAborted();
    const executable = join(runtimeDirectory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!(await lstat(executable)).isFile()) throw new Error('The bundled inference engine is missing.');
    const reserve = createServer();
    await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    apiKey = randomBytes(32).toString('base64url');
    const keyFile = join(directory, 'models', `runtime-${randomUUID()}.key`);
    await writeFile(keyFile, apiKey, { mode: 0o600, flag: 'wx' });
    try { lifetime.signal.throwIfAborted(); } catch (error) { await unlink(keyFile).catch(() => {}); throw error; }
    stopping = false;
    const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'LANG'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    child = spawn(executable, ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--api-key-file', keyFile, '--ctx-size', '4096', '--parallel', '1', '--jinja', '--no-webui', '--log-disable'], { shell: false, stdio: 'ignore', windowsHide: true, cwd: runtimeDirectory, env });
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; endpoint = undefined; if (!stopping) publish({ state: 'error', message: 'The local model stopped. Your notes are preserved.' }); });
    const readyBy = Date.now() + 90000;
    try {
      while (Date.now() < readyBy && !failed && !stopping) {
        try {
          const result = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(1000) });
          if (result.ok) { endpoint = `http://127.0.0.1:${port}/v1/chat/completions`; readyOnce = true; publish({ state: 'ready', percent: 100, message: 'Qwen3 1.7B is ready. Inference stays on this computer.' }); return; }
        } catch { /* The owned process may still be loading the model. */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('The local model could not start.');
    } finally { await unlink(keyFile).catch(() => {}); if (!endpoint) await terminateChild(); }
  }
  async function work(download) {
    lifetime.signal.throwIfAborted();
    if (child && endpoint) return { ...state };
    publish({ state: 'installing', percent: 0, message: 'Checking the local model…' });
    try {
      await mkdir(join(directory, 'models'), { recursive: true, mode: 0o700 });
      if (!await verifiedFile(modelPath, resource)) {
        if (!download) { publish({ state: 'missing', message: 'The local model is not set up for research reviews.' }); return { ...state }; }
        const existing = join(homedir(), '.ollama', 'models', 'blobs', `sha256-${resource.sha256}`);
        // Reuse the exact verified model when present, without changing a user's Ollama installation.
        if (await verifiedFile(existing, resource)) {
          publish({ state: 'installing', percent: 0, message: 'Importing your existing verified Qwen model…' });
          await copyFile(existing, modelPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
          if (!await verifiedFile(modelPath, resource)) throw new Error('The imported model failed verification.');
        } else await verifiedDownload({ ...resource, destination: modelPath, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1800000)]), onProgress: percent => publish({ state: 'installing', percent, message: 'Downloading Qwen3 1.7B. This happens once; Journal notes stay local.' }) });
      }
      lifetime.signal.throwIfAborted();
      publish({ state: 'installing', percent: 100, message: 'Starting the local model…' }); await start();
    } catch (error) { if (!lifetime.signal.aborted) publish({ state: 'error', message: /^The local model could not start|^The bundled inference|^An existing resource failed verification/.test(error.message) ? error.message : 'Local model setup could not finish. Your Journal is preserved.' }); }
    return { ...state };
  }
  async function ensure(download) {
    if (download && existingModelPath !== undefined) throw new Error('Existing-model mode cannot download or copy model resources.');
    if (!pending) pending = work(download).finally(() => { pending = null; }); return pending;
  }
  async function terminateChild() {
    stopping = true; endpoint = undefined;
    if (!child || child.exitCode !== null) { child = undefined; return; }
    const current = child; child = undefined;
    await new Promise(resolve => { const timer = setTimeout(() => { current.kill('SIGKILL'); resolve(); }, 4000); timer.unref(); current.once('exit', () => { clearTimeout(timer); resolve(); }); current.kill(); });
  }
  async function stop() { lifetime.abort(); await terminateChild(); await pending; }
  return {
    status: () => ({ ...state }), initialize: () => ensure(false), setup: () => ensure(true), stop,
    modelStatus: async () => ({ available: Boolean(endpoint), installed: state.state === 'ready', model: MODEL }),
    async classify({ entry, instructions = '', signal, onOutput }) {
      if (!endpoint || state.state !== 'ready') throw modelUnavailable(lifetime.signal.aborted ? 'The local model has stopped.'
        : state.state === 'error' ? state.message
          : state.state === 'installing' ? 'The local model is still starting. The research review could not start yet.'
            : 'The desktop local model is not set up. The research review could not start.');
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(90000)]), body: JSON.stringify({ model: 'qwen3-1.7b', stream: true, temperature: 0, max_tokens: 256, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: { name: 'classification', strict: true, schema: decisionSchema } }, messages: classificationMessages(entry, instructions) }) });
        if (!response.ok) throw modelUnavailable('The desktop local model is unavailable.');
        return await readClassificationStream(response, { protocol: 'openai', onOutput });
      } catch (error) {
        if (signal?.aborted || lifetime.signal.aborted) throw error;
        if (state.state === 'error') throw modelUnavailable(state.message);
        if (error.code === 'LOCAL_MODEL_UNAVAILABLE' || /local model|classification/i.test(error.message)) throw error;
        if (error instanceof SyntaxError) throw new Error('The local model returned unreadable classification data.');
        throw modelUnavailable('The local model connection was interrupted during its response.');
      }
    },
  };
}
