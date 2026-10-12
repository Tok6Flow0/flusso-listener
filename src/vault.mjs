import { createHash } from 'node:crypto';

// Never put credentials in shell arguments, environment variables, logs or SQLite.
export async function createVault(directory) {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const namespace = createHash('sha256').update(directory).digest('hex').slice(0, 24);
  const entry = name => new AsyncEntry('stream.flusso.listener', `${namespace}:${name}`, { linux: { store: 'secret-service' } });
  return {
    get: name => entry(name).getPassword(),
    set: (name, value) => entry(name).setPassword(value),
    delete: name => entry(name).deleteCredential(),
  };
}
