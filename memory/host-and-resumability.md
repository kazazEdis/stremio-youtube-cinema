# The host will kill you

The reference machine is an Android 16 "Linux Terminal" VM on a phone, not a
server. During one day it died **ten times**. That is not incidental to the
design — it is the reason for most of the pipeline's shape, and the lessons hold
on any host that can lose a process mid-write.

## Two causes, told apart by one number

Check `oom_score_adj` in the kill event:

- **adj 200 — backgrounded, killed for memory.** crosvm runs with a fixed
  `--mem`, there is no virtio-balloon, so guest memory is never returned to the
  host once touched. The VM is the largest allocation on the device.
- **adj 0 — foreground, and the app crashed.** A null-Handler NPE in the
  Terminal app's own WebView callback, fired when the app is backgrounded and
  resumed. LMKD does not kill adj 0; this is the app killing itself.

The second one was missed for a full day because the first is the obvious
explanation and it is *half* right. Battery and doze settings are a dead end —
they were already correct before anyone touched them.

## What follows

**A kill is power loss.** Unflushed page cache is gone. A plain log file loses
its tail, a half-written JSON file stays half-written, and a git object can end
up zero-length — which happened, corrupting the repository and taking twelve
objects with it.

- **SQLite in WAL mode survived every kill.** Nothing else did reliably. That is
  a large part of why the warehouse is SQLite rather than JSON files.
- **Checkpoint mid-pass, not between passes.** A 25-minute stage that only
  records progress at the end records nothing.
- **The work list *is* the checkpoint.** `fct_resolution` is queried for rows
  whose inputs changed; there is no separate progress file to fall out of sync.
- **`/tmp` is tmpfs and is wiped by the restart.** A long job's log belongs
  outside it, which is learned by losing one.
- **Downloads need `If-Range` plus verification.** A dropped socket ends
  `fetch()` *cleanly*, so a truncated file looks complete. See
  [imdb-datasets](imdb-datasets.md).
- **`pkill -f <pattern>` matches your own shell.** It kills the command that
  issued it, exit 144. Use the pid.

## The cheap diagnostic

A journal that stops mid-line with no shutdown sequence, and `uptime` under ten
minutes, is a kill. `journalctl --list-boots` confirms it in seconds.
