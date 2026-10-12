import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const name = 'stream.flusso.listener';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unit = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
export function serviceDefinition({ platform = process.platform, node = process.execPath, script = cli, directory, home = homedir() }) {
  if ([node, script, directory, home].some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('Invalid service path.');
  if (platform === 'darwin') return { path: join(home, 'Library', 'LaunchAgents', `${name}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[node, script, 'start', '--no-browser', '--data-dir', directory].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(directory, 'service.log'))}</string></dict></plist>` };
  if (platform === 'linux') return { path: join(home, '.config', 'systemd', 'user', 'flusso-listener.service'), content: `[Unit]\nDescription=Flusso local Journal listener\nAfter=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${[node, script, 'start', '--no-browser', '--data-dir', directory].map(unit).join(' ')}\nRestart=on-failure\nRestartSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  if (platform === 'win32') return { path: join(directory, 'login-task.xml'), content: `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml([script, 'start', '--no-browser', '--data-dir', directory].map(value => '"' + value.replaceAll('"', '\\"') + '"').join(' '))}</Arguments></Exec></Actions></Task>` };
  throw new Error('Automatic login services support macOS, Windows, and Linux.');
}
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('The OS could not install or remove the user service. See docs/always-on.md.'))); }); }
export async function installService({ directory }) {
  const definition = serviceDefinition({ directory }); await mkdir(join(definition.path, '..'), { recursive: true });
  if (process.platform === 'darwin') { await writeFile(join(directory, 'service.log'), '', { mode: 0o600, flag: 'a' }); await chmod(join(directory, 'service.log'), 0o600); }
  await writeFile(definition.path, definition.content, { mode: 0o600, encoding: process.platform === 'win32' ? 'utf16le' : 'utf8' });
  if (process.platform === 'darwin') await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition.path]);
  else if (process.platform === 'linux') { await run('systemctl', ['--user', 'daemon-reload']); await run('systemctl', ['--user', 'enable', '--now', 'flusso-listener.service']); }
  else await run('schtasks.exe', ['/Create', '/TN', 'FlussoListener', '/XML', definition.path, '/F']);
}
export async function removeService({ directory }) {
  const definition = serviceDefinition({ directory });
  if (process.platform === 'darwin') await run('launchctl', ['bootout', `gui/${process.getuid()}/${name}`]);
  else if (process.platform === 'linux') await run('systemctl', ['--user', 'disable', '--now', 'flusso-listener.service']);
  else await run('schtasks.exe', ['/Delete', '/TN', 'FlussoListener', '/F']);
  await unlink(definition.path);
  if (process.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload']);
}
