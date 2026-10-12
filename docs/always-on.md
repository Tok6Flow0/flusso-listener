# Run while logged in

First test the Journal and Listener in the foreground. Installing a user service
is an explicit optional action; it does not approve a trading policy or enable
execution. Keep the computer awake, Ollama available and the OS vault unlocked.
A laptop asleep, powered off or disconnected cannot watch a cloud Journal.

From the installed repository, opt into startup at user login:

```sh
node src/cli.mjs service install
```

The app writes a macOS LaunchAgent, Linux systemd user service, or Windows Task
Scheduler login task using the exact current Node and repository paths. It uses
your interactive user account and does not request administrator/root access.
Moving the repository or replacing the Node executable requires reinstalling the
service. The GUI is opened separately:

```sh
node src/cli.mjs open
```

The listener's saved on/off selection survives restart; existing notes are
baselined at startup. Durable unknown execution attempts are reconciled before
new admissions. The app does not catch up missed trades from a sleeping computer.
On Windows, the task starts at the next login; on macOS/Linux installation also
starts the user service. Keep Ollama set to start at login using its own settings.

Remove startup integration with:

```sh
node src/cli.mjs service remove
```

This removes/stops the login service, not your encrypted Journal. On Windows,
stop any currently running Listener task separately in Task Scheduler; deleting
a task does not stop its already running process. Use Ctrl+C for a foreground
process. User services are not system daemons and do not bypass vault locking.

macOS service output is in `service.log` in the private data directory. Linux
uses the user journal (`journalctl --user -u flusso-listener`). The local launch
URL is an unlocking capability: do not share these logs. Windows Task Scheduler
reports process failures through its task history. The app intentionally avoids
printing cloud credentials, Journal contents or upstream error bodies.
