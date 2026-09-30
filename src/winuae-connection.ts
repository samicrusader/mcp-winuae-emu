/**
 * WinUAE connection management and launcher
 * Connects to BartmanAbyss WinUAE fork with GDB RSP server
 *
 * Launch shape:
 *   1. -f <config> when the caller named one, otherwise WinUAE's own default
 *   2. -G to suppress the settings panel (use_gui=no in a config does NOT work)
 *   3. -s debugging_features=gdbserver
 * The GDB server listens on port 2345 by default.
 *
 * NOT -portable.  It writes a winuae.ini beside the exe, and from then on that
 * ini forces portable mode on every later launch -- including ones started by
 * hand without the flag -- which overrides -f and silently boots whatever the
 * portable store holds instead of the requested config.
 *
 * WINUAE_TRACE=1: enable trace logging to %TEMP%/winuae-mcp/mcp-trace-*.log
 * WINUAE_GDB_MAX_ATTEMPTS: default 40 (20s at 500ms)
 */

import { spawn, ChildProcess } from 'child_process';
import { GdbConnectOptions, GdbProtocol } from './gdb-protocol.js';
import { trace, traceErr } from './trace.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface WinUAEConfig {
  winuaePath: string;
  configFile: string;
  gdbPort: number;
}

export interface WinUAEConnectBehavior extends GdbConnectOptions {}

export type SessionIdleAction = 'detach' | 'shutdown';

export class WinUAEConnection {
  private config: WinUAEConfig;
  private process: ChildProcess | null = null;
  private protocol: GdbProtocol | null = null;
  private isConnected = false;
  private logFilePath: string | null = null;
  private floppies: Map<number, string> = new Map();
  private sessionIdleTimeoutMs = Math.max(0, parseInt(process.env.WINUAE_SESSION_IDLE_TIMEOUT_MS || '0', 10));
  private sessionIdleAction: SessionIdleAction =
    process.env.WINUAE_SESSION_IDLE_ACTION === 'shutdown' ? 'shutdown' : 'detach';
  private sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt: Date | null = null;
  private lastActivityReason = 'never';
  private connectionMode: 'launched' | 'attached' | 'disconnected' = 'disconnected';

  constructor(config: WinUAEConfig) {
    this.config = config;
  }

  /**
   * Parse a WinUAE .uae config file into key-value Map.
   * Skips comment lines (starting with ;) and blank lines.
   */
  private parseCfg(content: string): Map<string, string> {
    const out = new Map<string, string>();
    const lines = content.split(/[\r\n]+/g);
    const re = /^([^=]+)=(.*)$/;
    for (const line of lines) {
      if (line.startsWith(';') || line.trim() === '') continue;
      const match = line.match(re);
      if (match) {
        out.set(match[1], match[2]);
      }
    }
    return out;
  }

  /**
   * Stringify a config Map back to WinUAE .uae format.
   */
  private stringifyCfg(cfg: Map<string, string>): string {
    let out = '';
    cfg.forEach((value, key) => {
      out += `${key}=${value}\r\n`;
    });
    return out;
  }

  /**
   * Launch WinUAE (Bartman GDB fork) and connect to GDB server.
   *
   * 1. Pass the caller's config with -f (never copied over default.uae)
   * 2. Force the GDB/GUI settings on the command line with -s
   * 3. Retry-connect to TCP port 2345
   */
  async connect(connectBehavior: WinUAEConnectBehavior = {}): Promise<void> {
    if (this.isConnected) {
      throw new Error('Already connected to WinUAE');
    }

    // Default: winuae-gdb.exe (32-bit, built by WinUAE-DBG). x64 outputs winuae-gdb-x64.exe
    let exeName = (process.env.WINUAE_EXE || 'winuae-gdb.exe').trim();
    let exePath = path.join(this.config.winuaePath, exeName);
    trace(`connect: exe=${exeName} path=${exePath} exists=${fs.existsSync(exePath)}`);

    if (!fs.existsSync(exePath)) {
      const fallback = path.join(this.config.winuaePath, 'winuae-gdb-x86.exe');
      trace(`Primary not found, trying fallback: ${fallback} exists=${fs.existsSync(fallback)}`);
      if (fs.existsSync(fallback)) {
        exePath = fallback;
        exeName = 'winuae-gdb-x86.exe';
      } else {
        throw new Error(
          `${exeName} not found at ${exePath}. ` +
          `Build WinUAE-DBG with "build.bat" (Win32) or set WINUAE_EXE.`
        );
      }
    }

    const launchCwd = process.env.WINUAE_CWD
      ? path.resolve(process.env.WINUAE_CWD)
      : path.resolve(this.config.winuaePath);
    const legacyLaunch = process.env.WINUAE_USE_LEGACY_LAUNCH === '1';
    const exeInLaunchCwd = path.join(launchCwd, exeName);
    if (!legacyLaunch && fs.existsSync(exeInLaunchCwd)) {
      exePath = exeInLaunchCwd;
      trace(`Using WinUAE from launch cwd: ${exePath}`);
    }
    const useConfigFile = this.config.configFile && fs.existsSync(this.config.configFile);
    const configFileAbs = useConfigFile ? path.resolve(this.config.configFile) : '';
    if (!useConfigFile) {
      // Nothing to write anywhere: without -portable a default.uae beside the
      // exe is not read at all, so WinUAE uses its own configured default and
      // the -s overrides below still apply.
      trace('No user config; launching on WinUAE\'s own default configuration');
    } else {
      // The user's config is passed with -f below. We deliberately no longer copy
      // it over default.uae in the install directory: that write lands in Program
      // Files, and when it (or the subsequent load) failed, WinUAE fell through to
      // the A500/KS1.3 quickstart with no indication anything had gone wrong.
      trace(`Launching with -f: ${configFileAbs}`);
    }

    // Create log file
    const logDir = path.join(os.tmpdir(), 'winuae-mcp');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, `winuae-${Date.now()}.log`);
    const logFd = fs.openSync(this.logFilePath, 'w');

    const args: string[] = [];
    if (useConfigFile && configFileAbs) {
      args.push('-f', configFileAbs);
    }
    const headless = process.env.WINUAE_HEADLESS === '1';
    // None of the following are optional, and none of them depend on the launch
    // style. Commit f6eb535 moved them inside `if (legacyLaunch)`, which left the
    // default path launching with no switches at all: WinUAE then opened its
    // settings panel and never started a GDB server.
    args.push('-G');
    if (!headless) {
      args.push('-s', 'headless=no');
    }
    args.push('-s', 'debugging_features=gdbserver');
    // A config saved with use_gui=yes still opens the settings panel on boot.
    args.push('-s', 'use_gui=no');
    // win32.inactive_input makes WinUAE consume keystrokes while its window is
    // not focused, which is startling on a machine being driven over GDB.
    // Set WINUAE_KEEP_INACTIVE_INPUT=1 to leave the config's own value alone.
    if (process.env.WINUAE_KEEP_INACTIVE_INPUT !== '1') {
      args.push('-s', 'win32.inactive_input=0');
    }
    // Do NOT override debugging_trigger: let config file decide (e.g. :a.exe).
    // F5/amiga-debug uses it to auto-load the program when GDB connects.
    if (process.env.WINUAE_DEBUGGING_TRIGGER !== undefined) {
      args.push('-s', `debugging_trigger=${process.env.WINUAE_DEBUGGING_TRIGGER}`);
    }
    // If no DF0: was set via winuae_insert_disk, use WINUAE_BOOT_ADF so the Amiga boots (avoids black screen).
    if (!this.floppies.has(0) && process.env.WINUAE_BOOT_ADF) {
      const bootAdf = path.resolve(process.env.WINUAE_BOOT_ADF);
      if (fs.existsSync(bootAdf)) {
        args.push('-s', `floppy0=${bootAdf}`);
        trace(`Boot ADF (WINUAE_BOOT_ADF): ${bootAdf}`);
      }
    }
    for (const [drive, diskPath] of this.floppies) {
      args.push('-s', `floppy${drive}=${diskPath}`);
    }

    trace(`Launching ${exePath} ${args.join(' ')}`);
    trace(`GDB port: ${this.config.gdbPort}, log: ${this.logFilePath}`);
    
    const spawnedProcess = spawn(exePath, args, {
      stdio: ['ignore', logFd, logFd],
      detached: false,
      cwd: launchCwd,
      windowsHide: headless,
    });
    this.process = spawnedProcess;

    spawnedProcess.on('error', (err) => {
      traceErr('Process error', err);
      try { fs.closeSync(logFd); } catch {}
    });

    spawnedProcess.on('exit', (code) => {
      trace(`Process exited with code ${code}`);
      try { fs.closeSync(logFd); } catch {}
      if (this.process === spawnedProcess) {
        this.cleanup(false);
        this.process = null;
      }
    });

    const initialDelayMs = parseInt(process.env.WINUAE_GDB_INITIAL_DELAY_MS || '5000', 10);
    if (initialDelayMs > 0) {
      trace(`Waiting ${initialDelayMs}ms for WinUAE to start...`);
      await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }

    // Wait for GDB server to become available
    try {
      await this.waitForGdb(connectBehavior);
    } catch (err) {
      // Close log fd and clean up if GDB connection fails after launch
      try { fs.closeSync(logFd); } catch {}
      this.cleanup(true);
      throw err;
    }
  }

  /**
   * Connect to an already-running WinUAE instance (no process spawn)
   */
  async connectExisting(connectBehavior: WinUAEConnectBehavior = {}): Promise<void> {
    if (this.isConnected) {
      throw new Error('Already connected to WinUAE');
    }

    trace(`connectExisting: port ${this.config.gdbPort}`);
    await this.waitForGdb(connectBehavior);
    this.connectionMode = 'attached';
    this.markActivity('connect_existing');
  }

  /**
   * Try to quickly connect to an existing GDB server (fast, 2 attempts).
   * Returns true if connected, false if no server found.
   */
  private async tryQuickConnect(connectBehavior: WinUAEConnectBehavior = {}): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.protocol = new GdbProtocol();
        await this.protocol.connect('127.0.0.1', this.config.gdbPort, connectBehavior);
        this.isConnected = true;
        this.connectionMode = 'attached';
        this.markActivity('connect_existing');
        trace('tryQuickConnect: connected');
        return true;
      } catch (e) {
        traceErr('tryQuickConnect attempt failed', e);
        if (this.protocol) {
          this.protocol.disconnect();
          this.protocol = null;
        }
        if (attempt < 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
    return false;
  }

  /**
   * Smart connect: try existing GDB server first, then launch WinUAE if needed.
   * Returns a status message describing what happened.
   */
  async connectSmart(connectBehavior: WinUAEConnectBehavior = {}): Promise<string> {
    if (this.isConnected) {
      throw new Error('Already connected to WinUAE');
    }

    // Try quick connect to an already-running instance
    if (await this.tryQuickConnect(connectBehavior)) {
      return `Connected to existing WinUAE GDB server on port ${this.config.gdbPort}`;
    }

    trace('No existing GDB server, launching WinUAE...');
    await this.connect(connectBehavior);
    return `Launched WinUAE and connected to GDB server on port ${this.config.gdbPort}`;
  }

  /**
   * Wait for GDB server. Default: 40 attempts x 500ms = 20s.
   * WINUAE_GDB_MAX_ATTEMPTS, WINUAE_GDB_DELAY_MS to override.
   */
  private async waitForGdb(connectBehavior: WinUAEConnectBehavior = {}): Promise<void> {
    // A real config (Kickstart + hardfiles + autoconfig) needs well over the 5s
    // the old default allowed, so a perfectly good launch was reported as a
    // connection failure. 40 x 500ms = 20s, still fast to fail when nothing is
    // listening because each attempt refuses immediately.
    const maxAttempts = parseInt(process.env.WINUAE_GDB_MAX_ATTEMPTS || '40', 10);
    const delayMs = parseInt(process.env.WINUAE_GDB_DELAY_MS || '500', 10);
    trace(`waitForGdb: maxAttempts=${maxAttempts} delayMs=${delayMs} (${(maxAttempts * delayMs) / 1000}s max)`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        trace(`Attempt ${attempt + 1}/${maxAttempts} connecting to 127.0.0.1:${this.config.gdbPort}`);
        this.protocol = new GdbProtocol();
        await this.protocol.connect('127.0.0.1', this.config.gdbPort, connectBehavior);

        this.isConnected = true;
        this.connectionMode = this.process ? 'launched' : 'attached';
        this.markActivity('connect');
        trace('Connected to GDB server');
        return;
      } catch (err) {
        traceErr(`Attempt ${attempt + 1} failed`, err);
        if (this.protocol) {
          this.protocol.disconnect();
          this.protocol = null;
        }

        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    const stillRunning = this.process !== null && this.process.exitCode === null;
    throw new Error(
      `Failed to connect to WinUAE GDB server on port ${this.config.gdbPort} after ` +
      `${maxAttempts} attempts (${(maxAttempts * delayMs) / 1000}s). ` +
      (stillRunning
        ? 'The emulator process is still running, so it launched but never opened the port: ' +
          'check that debugging_features=gdbserver reached it and that no other WinUAE is ' +
          'already bound to this port. Raise WINUAE_GDB_MAX_ATTEMPTS if this machine is just slow to boot.'
        : 'The emulator process is no longer running, so it failed at startup: check WINUAE_PATH ' +
          'and the .uae config path.')
    );
  }

  /**
   * Restart WinUAE with updated configuration (preserves floppy state).
   */
  async restart(): Promise<string> {
    trace('Restarting with updated configuration...');
    this.cleanup(true);
    await this.connect();
    return `Restarted WinUAE and connected to GDB server on port ${this.config.gdbPort}`;
  }

  /**
   * Disconnect from GDB and optionally stop WinUAE.
   */
  async disconnect(stopEmulator: boolean = true): Promise<void> {
    if (!this.isConnected && !this.hasTrackedProcess()) {
      return;
    }

    this.cleanup(stopEmulator);
    if (this.logFilePath) trace(`Log file: ${this.logFilePath}`);
    trace('Disconnected');
  }

  private cleanup(stopEmulator: boolean): void {
    this.isConnected = false;
    this.connectionMode = 'disconnected';
    this.clearIdleTimer();

    if (this.protocol) {
      this.protocol.disconnect();
      this.protocol = null;
    }

    if (stopEmulator && this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * Get the GDB protocol handler
   */
  getProtocol(): GdbProtocol {
    if (!this.protocol || !this.isConnected) {
      throw new Error('Not connected to WinUAE');
    }
    return this.protocol;
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Health check: try reading registers
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConnected || !this.protocol) {
      return false;
    }
    try {
      await this.protocol.readRegisters();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set or clear a floppy disk image for a drive (0-3).
   * Takes effect on next connect() or restart().
   */
  setFloppy(drive: number, filePath: string | null): void {
    if (drive < 0 || drive > 3) throw new Error('Drive must be 0-3');
    if (filePath) {
      this.floppies.set(drive, filePath);
    } else {
      this.floppies.delete(drive);
    }
  }

  getFloppies(): Map<number, string> {
    return new Map(this.floppies);
  }

  setSessionIdlePolicy(timeoutMs: number, action?: SessionIdleAction): void {
    this.sessionIdleTimeoutMs = Math.max(0, Math.trunc(timeoutMs));
    if (action) {
      this.sessionIdleAction = action;
    }
    if (this.isConnected) {
      this.markActivity('session_policy_update');
    } else {
      this.clearIdleTimer();
    }
  }

  markActivity(reason: string): void {
    this.lastActivityAt = new Date();
    this.lastActivityReason = reason;
    this.scheduleIdleTimer();
  }

  hasTrackedProcess(): boolean {
    return !!this.process && this.process.exitCode === null && !this.process.killed;
  }

  canAutoRestartManagedProcess(): boolean {
    return this.connectionMode === 'launched' && this.hasTrackedProcess();
  }

  getSessionInfo(): {
    connected: boolean;
    connectionMode: 'launched' | 'attached' | 'disconnected';
    trackedProcessRunning: boolean;
    trackedProcessId: number | null;
    idleTimeoutMs: number;
    idleAction: SessionIdleAction;
    lastActivityAt: string | null;
    lastActivityReason: string;
    logFilePath: string | null;
    configFile: string;
    winuaePath: string;
    gdbPort: number;
  } {
    return {
      connected: this.isConnected,
      connectionMode: this.connectionMode,
      trackedProcessRunning: this.hasTrackedProcess(),
      trackedProcessId: this.process?.pid ?? null,
      idleTimeoutMs: this.sessionIdleTimeoutMs,
      idleAction: this.sessionIdleAction,
      lastActivityAt: this.lastActivityAt ? this.lastActivityAt.toISOString() : null,
      lastActivityReason: this.lastActivityReason,
      logFilePath: this.logFilePath,
      configFile: this.config.configFile,
      winuaePath: this.config.winuaePath,
      gdbPort: this.config.gdbPort,
    };
  }

  private clearIdleTimer(): void {
    if (this.sessionIdleTimer) {
      clearTimeout(this.sessionIdleTimer);
      this.sessionIdleTimer = null;
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.isConnected || this.sessionIdleTimeoutMs <= 0) {
      return;
    }

    this.sessionIdleTimer = setTimeout(() => {
      const action = this.sessionIdleAction;
      trace(`Idle timeout reached (${this.sessionIdleTimeoutMs}ms), action=${action}`);
      void this.disconnect(action === 'shutdown');
    }, this.sessionIdleTimeoutMs);
  }
}
