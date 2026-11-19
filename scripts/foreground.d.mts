export declare const ANOTHER_APP: "<another app>";

export type ForegroundWindow =
  | { at: string; hwnd: string; pid: number; name: string; ours: true }
  | { at: string; hwnd: string; name: typeof ANOTHER_APP; ours: false };

export declare function parseForeground(line: string, own: { pids: number[]; hwnd?: string | number | null }): ForegroundWindow;

export declare function describeWindow(w: ForegroundWindow | undefined): string;
