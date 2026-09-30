/**
 * GDB Remote Serial Protocol (RSP) client for BartmanAbyss WinUAE fork
 * Handles packet framing, checksum, ack mode, and all m68k debug commands
 */

import { Socket } from 'net';
import { trace, traceErr } from './trace.js';

// m68k register layout in GDB order (18 regs × 4 bytes each, big-endian)
export interface M68kRegisters {
  D0: number; D1: number; D2: number; D3: number;
  D4: number; D5: number; D6: number; D7: number;
  A0: number; A1: number; A2: number; A3: number;
  A4: number; A5: number; A6: number; A7: number;
  SR: number; PC: number;
}

export type WatchpointType = 'write' | 'read' | 'access';

export interface GdbConnectOptions {
  forceBreak?: boolean;
  initializeStopped?: boolean;
}

const REGISTER_NAMES: (keyof M68kRegisters)[] = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  'SR', 'PC',
];

const WATCHPOINT_TYPE_MAP: Record<WatchpointType, number> = {
  write: 2,
  read: 3,
  access: 4,
};

export class GdbProtocol {
  private socket: Socket | null = null;
  private receiveBuffer = '';
  private noAckMode = false;
  private packetResolvers: Array<{
    resolve: (data: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private debugMode = process.env.WINUAE_DEBUG === '1';
  private pendingData = '';
  private _isRunning = false;
  private pendingStopReply: string | null = null;

  /**
   * Connect to GDB server and perform handshake
   */
  async connect(host: string, port: number, options: GdbConnectOptions = {}): Promise<void> {
    const connectTimeoutMs = parseInt(process.env.WINUAE_GDB_CONNECT_TIMEOUT_MS || '3000', 10);
    const forceBreak = options.forceBreak ?? (process.env.WINUAE_FORCE_BREAK !== '0');
    const initializeStopped = options.initializeStopped ?? forceBreak;
    trace(`GDB connect ${host}:${port} timeout=${connectTimeoutMs}ms`);

    this.socket = new Socket();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        traceErr('GDB TCP connect timeout', new Error('timeout'));
        reject(new Error(`GDB connection timeout (${connectTimeoutMs}ms)`));
      }, connectTimeoutMs);

      this.socket!.connect(port, host, () => {
        clearTimeout(timeout);
        trace('GDB TCP connected');
        resolve();
      });

      this.socket!.on('error', (err) => {
        clearTimeout(timeout);
        traceErr('GDB TCP error', err);
        reject(err);
      });
    });

    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('error', (err) => {
      this.debug(`[GDB] Socket error: ${err.message}`);
      this.rejectAll(new Error(`Socket error: ${err.message}`));
    });
    this.socket.on('close', () => {
      this.debug('[GDB] Socket closed');
      this.rejectAll(new Error('Socket closed'));
    });

    // WinUAE only processes packets after Amiga hits a breakpoint and enters debugger.
    // For ADF games without debugging_trigger, we need to send Ctrl+C first to force debug mode.
    // Send Ctrl+C (0x03) to interrupt execution and enter debug mode.
    if (forceBreak) {
      trace('[GDB] Sending Ctrl+C to force debug mode...');
      this.socket.write(Buffer.from([0x03]));
      // Wait a bit for WinUAE to process the break
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      trace('[GDB] Skipping initial Ctrl+C; connecting in non-intrusive mode.');
    }

    // Allow up to 60s for the first command (boot + hit breakpoint).
    const supported = await this.sendCommand('qSupported:multiprocess+;swbreak+;hwbreak+', 60000);
    this.debug(`[GDB] qSupported response: ${supported}`);

    // Try to enable no-ack mode for speed (skip if WINUAE_USE_ACK=1; some stubs need acks for M packet)
    if (process.env.WINUAE_USE_ACK !== '1') {
      try {
        const ackReply = await this.sendCommand('QStartNoAckMode');
        if (ackReply === 'OK') {
          this.noAckMode = true;
          this.debug('[GDB] No-ack mode enabled');
        }
      } catch {
        this.debug('[GDB] No-ack mode not supported, continuing with acks');
      }
    } else {
      this.debug('[GDB] WINUAE_USE_ACK=1: keeping ack mode (may help memory write)');
    }

    if (initializeStopped) {
      // Query halt reason only when the target is expected to be stopped.
      const haltReason = await this.sendCommand('?');
      this.debug(`[GDB] Halt reason: ${haltReason}`);

      // Send qOffsets to trigger baseText calculation in WinUAE-DBG.
      // This is essential for breakpoint relocation when debugging user programs
      // but should be skipped for non-intrusive attaches during boot/disk activity.
      try {
        const offsets = await this.sendCommand('qOffsets');
        this.debug(`[GDB] qOffsets response: ${offsets}`);
      } catch (e) {
        this.debug(`[GDB] qOffsets not supported or failed: ${e}`);
      }
    } else {
      this.debug('[GDB] Non-intrusive attach: skipping initial halt-reason and qOffsets queries.');
    }
  }

  /**
   * Handle incoming TCP data
   */
  private handleData(data: Buffer): void {
    const raw = data.toString('binary');
    if (this.debugMode && raw.length > 0) trace(`[GDB RX] ${raw.length}B: ${JSON.stringify(raw.slice(0, 80))}${raw.length > 80 ? '...' : ''}`);
    this.pendingData += raw;

    while (this.pendingData.length > 0) {
      // Handle ack/nack bytes
      if (this.pendingData[0] === '+') {
        this.pendingData = this.pendingData.slice(1);
        continue;
      }
      if (this.pendingData[0] === '-') {
        this.debug('[GDB] Received NACK');
        this.pendingData = this.pendingData.slice(1);
        continue;
      }

      // Look for packet start
      const dollarIdx = this.pendingData.indexOf('$');
      if (dollarIdx === -1) {
        // No packet start found, discard
        this.pendingData = '';
        break;
      }

      // Skip any bytes before $
      if (dollarIdx > 0) {
        this.pendingData = this.pendingData.slice(dollarIdx);
      }

      // Look for packet end (#XX)
      const hashIdx = this.pendingData.indexOf('#');
      if (hashIdx === -1 || hashIdx + 2 >= this.pendingData.length) {
        // Incomplete packet, wait for more data
        break;
      }

      // Extract packet
      const packetData = this.pendingData.slice(1, hashIdx); // between $ and #
      const checksumStr = this.pendingData.slice(hashIdx + 1, hashIdx + 3);
      this.pendingData = this.pendingData.slice(hashIdx + 3);

      // Verify checksum
      const expectedChecksum = parseInt(checksumStr, 16);
      const actualChecksum = this.computeChecksum(packetData);

      if (expectedChecksum !== actualChecksum) {
        this.debug(`[GDB] Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
        if (!this.noAckMode) {
          this.socketWrite('-');
        }
        continue;
      }

      // Send ack
      if (!this.noAckMode) {
        this.socketWrite('+');
      }

      this.debug(`[GDB] [RECV] ${packetData.slice(0, 100)}${packetData.length > 100 ? '...' : ''}`);

      // O packets are async console output: O + hex-encoded text. Do not treat "OK" as O packet.
      if (packetData.startsWith('O') && packetData.length > 1 && /^O[0-9a-fA-F]+$/.test(packetData)) {
        try {
          const hexText = packetData.slice(1);
          const text = Buffer.from(hexText, 'hex').toString('utf8').trim();
          this.debug(`[GDB] Server output: ${text}`);
        } catch {
          this.debug(`[GDB] Server output (raw): ${packetData.slice(1, 50)}`);
        }
        continue;
      }

      // Async stop replies (S/T packets) when CPU was running with no resolver waiting
      if ((packetData.startsWith('S') || packetData.startsWith('T')) && this.packetResolvers.length === 0) {
        this.pendingStopReply = packetData;
        this._isRunning = false;
        this.debug(`[GDB] Async stop reply: ${packetData}`);
        continue;
      }

      // Deliver to waiting resolver
      const resolver = this.packetResolvers.shift();
      if (resolver) {
        clearTimeout(resolver.timer);
        // Track stop for run commands
        if (packetData.startsWith('S') || packetData.startsWith('T')) {
          this._isRunning = false;
        }
        resolver.resolve(packetData);
      } else {
        this.debug(`[GDB] Unsolicited packet: ${packetData.slice(0, 50)}`);
      }
    }
  }

  /**
   * Compute GDB RSP checksum (sum of bytes mod 256)
   */
  private computeChecksum(data: string): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data.charCodeAt(i);
    }
    return sum & 0xFF;
  }

  /**
   * Send a raw packet with framing: $data#XX
   */
  private sendPacket(data: string): void {
    const checksum = this.computeChecksum(data);
    const packet = `$${data}#${checksum.toString(16).padStart(2, '0')}`;
    if (this.debugMode) trace(`[GDB TX] ${data.slice(0, 80)}${data.length > 80 ? '...' : ''}`);
    this.socketWrite(packet);
  }

  /**
   * Send a command and wait for response
   */
  private sendCommand(command: string, timeoutMs: number = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.packetResolvers.findIndex(r => r.resolve === resolve);
        if (idx >= 0) {
          this.packetResolvers.splice(idx, 1);
        }
        reject(new Error(`GDB command timeout: ${command}`));
      }, timeoutMs);

      this.packetResolvers.push({ resolve, reject, timer });
      this.sendPacket(command);
    });
  }

  /**
   * Send a command and wait for stop reply (for continue/step)
   * These commands get a stop reply (S/T packet) when execution stops
   */
  private sendRunCommand(command: string, timeoutMs: number = 30000): Promise<string> {
    return this.sendCommand(command, timeoutMs);
  }

  private socketWrite(data: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data, 'binary');
    }
  }

  private debug(msg: string): void {
    if (this.debugMode) {
      console.error(msg);
    }
  }

  private rejectAll(error: Error): void {
    for (const resolver of this.packetResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(error);
    }
    this.packetResolvers = [];
  }

  // ─── Register Commands ──────────────────────────────────────────────

  /**
   * Read all registers: sends 'g', parses 18 × 8 hex chars (big-endian 32-bit)
   */
  async readRegisters(): Promise<M68kRegisters> {
    const reply = await this.sendCommand('g');
    if (reply.length < 144) {
      throw new Error(`Register reply too short: ${reply.length} chars (expected 144)`);
    }

    const regs: Partial<M68kRegisters> = {};
    for (let i = 0; i < 18; i++) {
      const hex = reply.slice(i * 8, i * 8 + 8);
      const value = parseInt(hex, 16); // big-endian
      (regs as any)[REGISTER_NAMES[i]] = value;
    }
    return regs as M68kRegisters;
  }

  /**
   * Read a single register by index
   */
  async readRegister(id: number): Promise<number> {
    const reply = await this.sendCommand(`p${id.toString(16)}`);
    return parseInt(reply, 16);
  }

  /**
   * Write a single register by index: sends 'P<id>=<hex>'
   * Uses a longer timeout — WinUAE GDB server responds slowly to register writes.
   */
  async writeRegister(id: number, value: number): Promise<void> {
    const hex = (value >>> 0).toString(16).padStart(8, '0');
    const reply = await this.sendCommand(`P${id.toString(16)}=${hex}`, 30000);
    if (reply !== 'OK') throw new Error(`Register write failed for reg ${id}: ${reply}`);
  }

  /**
   * Write all registers: sends 'G<hex>' (18 regs × 8 hex chars)
   */
  async writeRegisters(regs: M68kRegisters): Promise<void> {
    let hex = '';
    for (const name of REGISTER_NAMES) {
      hex += ((regs[name] as number) >>> 0).toString(16).padStart(8, '0');
    }
    const reply = await this.sendCommand(`G${hex}`);
    if (reply !== 'OK') throw new Error(`Register write-all failed: ${reply}`);
  }

  // ─── Memory Commands ────────────────────────────────────────────────

  /**
   * Read memory: sends 'm<addr>,<len>', returns Buffer
   */
  async readMemory(addr: number, length: number): Promise<Buffer> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const chunkSize = Math.max(1, parseInt(process.env.WINUAE_GDB_READ_CHUNK_SIZE || '1024', 10) || 1024);
    const baseTimeoutMs = Math.max(1000, parseInt(process.env.WINUAE_GDB_READ_TIMEOUT_MS || '20000', 10) || 20000);
    const timeoutPerKbMs = Math.max(0, parseInt(process.env.WINUAE_GDB_READ_TIMEOUT_PER_KB_MS || '1500', 10) || 1500);

    const readChunk = async (chunkAddr: number, chunkLength: number): Promise<Buffer> => {
      const timeoutMs = baseTimeoutMs + Math.ceil(chunkLength / 1024) * timeoutPerKbMs;
      trace(`readMemory chunk addr=$${chunkAddr.toString(16)} len=${chunkLength} timeout=${timeoutMs}ms`);
      const reply = await this.sendCommand(`m${chunkAddr.toString(16)},${chunkLength.toString(16)}`, timeoutMs);
      if (reply.startsWith('E')) {
        throw new Error(`Memory read error at $${chunkAddr.toString(16)}: ${reply}`);
      }
      return Buffer.from(reply, 'hex');
    };

    if (length <= chunkSize) {
      return readChunk(addr, length);
    }

    const chunks: Buffer[] = [];
    for (let offset = 0; offset < length; offset += chunkSize) {
      const chunkLength = Math.min(chunkSize, length - offset);
      chunks.push(await readChunk(addr + offset, chunkLength));
    }
    return Buffer.concat(chunks, length);
  }

  /**
   * Escape binary data for GDB X packet: 0x7d -> 0x7d 0x5d, 0x23 (#) -> 0x7d 0x03, 0x24 ($) -> 0x7d 0x04.
   */
  private static escapeXPacketData(data: Buffer): Buffer {
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b === 0x7d || b === 0x23 || b === 0x24) {
        out.push(0x7d, b ^ 0x20);
      } else {
        out.push(b);
      }
    }
    return Buffer.from(out);
  }

  /**
   * Write memory: try M packet first, then X (binary) as fallback.
   * Chunk size, timeout, and pacing are configurable for WinUAE builds that are
   * sensitive to large writes during early boot/debug attach.
   */
  async writeMemory(addr: number, data: Buffer): Promise<void> {
    const chunkSize = Math.max(1, parseInt(process.env.WINUAE_GDB_WRITE_CHUNK_SIZE || '256', 10) || 256);
    const minChunkSize = Math.max(1, parseInt(process.env.WINUAE_GDB_WRITE_MIN_CHUNK_SIZE || '16', 10) || 16);
    const timeoutMs = Math.max(1000, parseInt(process.env.WINUAE_GDB_WRITE_TIMEOUT_MS || '30000', 10) || 30000);
    const delayMs = Math.max(0, parseInt(process.env.WINUAE_GDB_WRITE_DELAY_MS || '0', 10) || 0);
    const log = (msg: string) => {
      this.debug(msg);
      console.error(`[GDB memory] ${msg}`);
    };

    const writeChunk = async (chunkAddr: number, chunk: Buffer): Promise<void> => {
      const chunkLen = chunk.length;
      const hex = chunk.toString('hex');
      const mPacket = `M${chunkAddr.toString(16)},${chunkLen.toString(16)}:${hex}`;
      log(`[SEND] M ${mPacket.slice(0, 80)}${mPacket.length > 80 ? '...' : ''}`);
      let reply: string | null = null;
      let lastError: Error | null = null;
      try {
        reply = await this.sendCommand(mPacket, timeoutMs);
        log(`[RECV] ${reply}`);
      } catch (err) {
        lastError = err as Error;
        log(`M packet failed: ${lastError.message}. Trying X packet...`);
      }

      if (reply === null) {
        try {
          const escaped = GdbProtocol.escapeXPacketData(chunk);
          const xPayload = 'X' + chunkAddr.toString(16) + ',' + chunkLen.toString(16) + ':' + escaped.toString('binary');
          reply = await this.sendCommand(xPayload, timeoutMs);
          log(`[RECV] X ${reply}`);
        } catch (err) {
          lastError = err as Error;
          log(`X packet failed: ${lastError.message}`);
        }
      }

      if (reply !== 'OK') {
        if (chunkLen > minChunkSize) {
          const splitAt = Math.max(minChunkSize, Math.floor(chunkLen / 2));
          const left = chunk.subarray(0, splitAt);
          const right = chunk.subarray(splitAt);
          log(`Retrying write at smaller chunk size: ${chunkLen} -> ${left.length}+${right.length}`);
          await writeChunk(chunkAddr, left);
          if (right.length > 0) {
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            await writeChunk(chunkAddr + left.length, right);
          }
          return;
        }
        throw new Error(`Memory write error at $${chunkAddr.toString(16)}: ${reply ?? lastError?.message ?? 'unknown_error'}`);
      }
    };

    let offset = 0;
    let currentAddr = addr;
    while (offset < data.length) {
      const chunkLen = Math.min(chunkSize, data.length - offset);
      const chunk = data.subarray(offset, offset + chunkLen);
      await writeChunk(currentAddr, chunk);
      offset += chunkLen;
      currentAddr += chunkLen;
      if (delayMs > 0 && offset < data.length) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // ─── Monitor Commands (qRcmd) ────────────────────────────────────────────

  /**
   * Send a monitor command (qRcmd). Command is hex-encoded in the packet.
   *
   * Supported by this fork's stub: status, memcfg, warp, watch, protect, base,
   * trace, df<n> insert/eject, input key|event|joy|mouse, screenshot, disasm,
   * profile, reset. Anything else answers E01 - notably debugperiph, train,
   * rewind and findproc, which only exist in the upstream author\'s private tree.
   *
   * Returns the raw reply. Most commands hex-encode their text (decode with
   * Buffer.from(hex, 'hex')); `warp` deliberately replies in plain text.
   */
  async sendMonitorCommand(command: string, timeoutMs: number = 60000): Promise<string> {
    const hexCmd = Buffer.from(command, 'utf8').toString('hex');
    const reply = await this.sendCommand(`qRcmd,${hexCmd}`, timeoutMs);
    if (reply.startsWith('E')) {
      const verb = command.split(/\s+/)[0];
      throw new Error(
        `Monitor command '${verb}' rejected by the WinUAE GDB stub (${reply}). ` +
        `The stub answers E01 for commands it does not implement; check that this ` +
        `WinUAE build is new enough to provide '${verb}'. Full command: ${command}`
      );
    }
    return reply;
  }

  /**
   * Query relocation offsets for the currently debugged program.
   * Typical reply: Text=00000400;Data=00012345;Bss=00023456
   */
  async queryOffsets(): Promise<string> {
    return this.sendCommand('qOffsets', 10000);
  }

  // ─── Breakpoint Commands ────────────────────────────────────────────

  /**
   * Set software breakpoint: Z0,<addr>,2
   */
  async setBreakpoint(addr: number): Promise<void> {
    const reply = await this.sendCommand(`Z0,${addr.toString(16)},2`);
    if (reply !== 'OK') {
      throw new Error(`Set breakpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  /**
   * Clear software breakpoint: z0,<addr>,2
   */
  async clearBreakpoint(addr: number): Promise<void> {
    const reply = await this.sendCommand(`z0,${addr.toString(16)},2`);
    if (reply !== 'OK') {
      throw new Error(`Clear breakpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  // ─── Watchpoint Commands ────────────────────────────────────────────

  /**
   * Set watchpoint: Z<type>,<addr>,<len>
   */
  async setWatchpoint(addr: number, length: number, type: WatchpointType): Promise<void> {
    const typeNum = WATCHPOINT_TYPE_MAP[type];
    const reply = await this.sendCommand(`Z${typeNum},${addr.toString(16)},${length.toString(16)}`);
    if (reply !== 'OK') {
      throw new Error(`Set watchpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  /**
   * Clear watchpoint: z<type>,<addr>,<len>
   */
  async clearWatchpoint(addr: number, length: number, type: WatchpointType): Promise<void> {
    const typeNum = WATCHPOINT_TYPE_MAP[type];
    const reply = await this.sendCommand(`z${typeNum},${addr.toString(16)},${length.toString(16)}`);
    if (reply !== 'OK') {
      throw new Error(`Clear watchpoint failed at $${addr.toString(16)}: ${reply}`);
    }
  }

  // ─── Execution Control ──────────────────────────────────────────────

  /**
   * Continue execution: sends 'vCont;c', returns immediately (fire-and-forget).
   * The stop reply will arrive asynchronously when a breakpoint/watchpoint fires.
   * Call waitForStop() after continue() to block until the target stops (breakpoint hit).
   * Note: BartmanAbyss WinUAE only supports vCont commands, not basic 'c'.
   */
  async continue(): Promise<void> {
    this.pendingStopReply = null;
    this._isRunning = true;
    this.sendPacket('vCont;c');
  }

  /**
   * Wait for the next stop reply (e.g. after continue(), when a breakpoint is hit).
   * Use after continue() so execution actually stops at breakpoints.
   */
  async waitForStop(timeoutMs: number = 30000): Promise<string> {
    if (this.pendingStopReply) {
      const reply = this.pendingStopReply;
      this.pendingStopReply = null;
      this._isRunning = false;
      return reply;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.packetResolvers.findIndex(r => r.resolve === resolve);
        if (idx >= 0) this.packetResolvers.splice(idx, 1);
        reject(new Error('Wait for stop timeout (breakpoint not hit?)'));
      }, timeoutMs);
      this.packetResolvers.push({ resolve, reject, timer });
    });
  }

  /**
   * Single step: sends 'vCont;s', waits for stop reply (step always stops quickly)
   * Note: BartmanAbyss WinUAE only supports vCont commands, not basic 's'.
   */
  async step(): Promise<string> {
    this._isRunning = true;
    const reply = await this.sendRunCommand('vCont;s');
    this._isRunning = false;
    return reply;
  }

  /**
   * Pause/interrupt execution. If CPU already stopped (async breakpoint hit),
   * returns the pending stop reply immediately. Otherwise sends 0x03 interrupt.
   */
  async pause(): Promise<string> {
    // If a stop reply arrived asynchronously (breakpoint fired), return it
    if (this.pendingStopReply) {
      const reply = this.pendingStopReply;
      this.pendingStopReply = null;
      return reply;
    }

    // If not running, just return
    if (!this._isRunning) {
      return 'S00';
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.packetResolvers.findIndex(r => r.resolve === resolve);
        if (idx >= 0) {
          this.packetResolvers.splice(idx, 1);
        }
        reject(new Error('Pause timeout'));
      }, 10000);

      this.packetResolvers.push({ resolve, reject, timer });

      // Send raw interrupt byte (not a GDB packet)
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(Buffer.from([0x03]));
      }
    });
  }

  /**
   * Whether the CPU is currently running (continue was sent, no stop reply yet)
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Disconnect from GDB server
   */
  disconnect(): void {
    this.rejectAll(new Error('Disconnected'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}
