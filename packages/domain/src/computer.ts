export interface ComputerCommand {
  id: string;
  command: string;
  /** Full input binding for keyed desktop actions; command is only a short display label. */
  actionHash?: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "interrupted" | "paused";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt?: string;
}
export interface ComputerSnapshot {
  enabled: boolean;
  provider: "docker" | "e2b-desktop";
  status: "unconfigured" | "stopped" | "running" | "error";
  workspacePath: "/workspace";
  /** Docker runs with networking off; the E2B desktop needs internet for its GUI browser. */
  network: "disabled" | "enabled";
  message?: string;
  commands: ComputerCommand[];
  /** Every receipt ever recorded for this provider; commands holds the newest 100. */
  totalCommands: number;
}
export interface ComputerDirectory {
  path: string;
  entries: { name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[];
}
