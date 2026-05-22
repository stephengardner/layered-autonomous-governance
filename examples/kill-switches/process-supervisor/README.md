# ProcessSupervisor (reference MediumTierKillSwitch)

Out-of-process kill-switch for child processes the host spawns and
needs to forcibly terminate on a halt condition (operator revocation,
deadline, escalation).

## Indie path

```ts
import { spawn } from 'node:child_process';
import { ProcessSupervisor } from './kill-switches/process-supervisor';

const killSwitch = new ProcessSupervisor();
const child = spawn(bin, args);
if (typeof child.pid === 'number') {
  await killSwitch.arm(child.pid);
}
child.on('exit', () => {
  if (typeof child.pid === 'number') {
    void killSwitch.disarm(child.pid);
  }
});

// later, on halt:
await killSwitch.tripAll();
```

## Platform handling

Selected once at construction time:

- **POSIX**: `process.kill(pid, 'SIGTERM')` followed by
  `process.kill(pid, 'SIGKILL')` after a short escalation window.
  Errors (ESRCH, EPERM) are swallowed - the contract is best-effort
  signaling, not death-confirmation.
- **Windows**: shells out to `taskkill /F /T /PID <pid>`, which walks
  the descendant process tree. A grandchild left orphaned by a shell
  wrapper still gets terminated.

## Notes

- In-memory trip set. A supervisor restart loses adopted PIDs; a host
  that needs persistence across supervisor crashes wraps this impl
  with its own durability layer.
- `arm()` does not validate the PID exists. Signaling a non-existent
  PID later is a no-op on both platforms; the validation cost is
  skipped.
- `tripAll()` returns when every armed PID has been signaled, not
  when the OS has confirmed exit. The contract is explicit about this.
