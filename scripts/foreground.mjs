// The e2e's foreground log, one window per line: `<at>\t<hwnd>\t<pid>\t<process name>`.
// The watcher never reads a window title. What counts as this run's own window is decided by
// this run's Chrome pids and the test window's handle, never by a name or a title, so the
// person's own Chrome is "another app" like any other.

export const ANOTHER_APP = "<another app>";

/**
 * One line of the log. A window of this run keeps its pid and process name; any other window
 * is only `<another app>` (its handle stays, opaque, to tell whether the foreground moved).
 * Anything after the fourth field is dropped.
 */
export function parseForeground(line, own) {
  const [at, hwnd, pid, name] = line.split("\t");
  const p = Number(pid);
  const ours = (own.hwnd !== undefined && own.hwnd !== null && hwnd === String(own.hwnd)) || own.pids.includes(p);
  return ours ? { at, hwnd, pid: p, name: name ?? "?", ours: true } : { at, hwnd, name: ANOTHER_APP, ours: false };
}

/** A window for the console summary: its process name and pid when it is this run's, else `<another app>`. */
export const describeWindow = (w) => (w ? (w.ours ? `${w.name}/${w.pid}` : ANOTHER_APP) : "none");
