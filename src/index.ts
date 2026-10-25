#!/usr/bin/env node

/**
 * MCP WinUAE Emulator Server
 * Provides Amiga 68k debugging tools via GDB RSP protocol through MCP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SessionIdleAction, WinUAEConnection, WinUAEConfig } from './winuae-connection.js';
import { GdbProtocol, M68kRegisters, WatchpointType } from './gdb-protocol.js';
import { analyzeProfile, ProfileOllamaRequest } from './profile-ollama.js';
import {
  buildCpuSnapshot,
  buildCustomRegisterSnapshot,
  buildMachineSnapshot,
  buildMemoryWindowErrorSnapshot,
  buildMemoryWindowSnapshot,
  CUSTOM_REGISTER_CHUNK_SIZE,
  CUSTOM_REGISTER_SIZE,
  readMemoryWindowChunked,
  normalizeMemoryWindow,
} from './machine-snapshot.js';
import {
  buildBitmapDecodeResponse,
  decodePlanarBitmap,
  encodePngRgba,
  normalizeBitmapDecodeRequest,
  rgbaToHex,
} from './bitmap-decode.js';
import { isAmigaHunkExecutable, loadAmigaHunk } from './amiga-hunk.js';
import {
  buildMemoryPatternSearchResponse,
  normalizeMemoryPatternSearchRequest,
  searchMemoryPattern,
} from './memory-pattern-search.js';
import {
  buildConditionalBreakpointResponse,
  evaluateConditionalBreakpoint,
  normalizeConditionalBreakpointRequest,
} from './conditional-breakpoint.js';
import {
  buildPostmortemReport,
  renderPostmortemMarkdown,
} from './postmortem.js';
import {
  applyAutomationInputPatch,
  AUTOMATION_INPUT_SIZE,
  buildAutomationInputResponse,
  resolveAutomationInputSymbolInfo,
  resolveEnterDemoAddress,
} from './amiga-automation-input.js';
import { captureWinUAEWindow } from './winuae-window-capture.js';
import { fixScreenshotPng } from './png-aspect.js';
import { trace, traceErr } from './trace.js';
import * as path from 'path';
import fs from 'fs';

// ─── Configuration from environment ──────────────────────────────────

const config: WinUAEConfig = {
  winuaePath: process.env.WINUAE_PATH || 'C:\\apps\\winuae',
  configFile: process.env.WINUAE_CONFIG || path.join(
    process.env.WINUAE_PATH || 'C:\\apps\\winuae',
    'Configurations',
    'A500-Dev.uae'
  ),
  gdbPort: parseInt(process.env.WINUAE_GDB_PORT || '2345', 10),
};

// Global connection instance
let connection: WinUAEConnection | null = null;

const CONNECTION_OPTIONAL_TOOLS = new Set([
  'winuae_connect',
  'winuae_connect_existing',
  'winuae_disconnect',
  'winuae_status',
  'winuae_session_config',
  'winuae_load',
  'winuae_insert_disk',
  'winuae_eject_disk',
  'winuae_profile_ollama',
]);

function getBaseConfigForArgs(args: Record<string, unknown>): WinUAEConfig {
  const configFile =
    args?.config_file && String(args.config_file).trim()
      ? path.resolve(String(args.config_file).trim())
      : config.configFile;
  return { ...config, configFile };
}

function cloneConnectionState(source: WinUAEConnection, target: WinUAEConnection): void {
  const info = source.getSessionInfo();
  target.setSessionIdlePolicy(info.idleTimeoutMs, info.idleAction);
  for (const [drive, filePath] of source.getFloppies()) {
    target.setFloppy(drive, filePath);
  }
}

function getConnectBehavior(args: Record<string, unknown>): { forceBreak?: boolean; initializeStopped?: boolean } {
  const behavior: { forceBreak?: boolean; initializeStopped?: boolean } = {};
  if (args.force_break !== undefined) {
    behavior.forceBreak = args.force_break !== false;
  }
  if (args.initialize_stopped !== undefined) {
    behavior.initializeStopped = args.initialize_stopped !== false;
  }
  if (behavior.initializeStopped === undefined && behavior.forceBreak === false) {
    behavior.initializeStopped = false;
  }
  return behavior;
}

async function tryAutoAttachForTool(name: string, args: Record<string, unknown>): Promise<void> {
  if (CONNECTION_OPTIONAL_TOOLS.has(name) || connection?.connected) {
    return;
  }

  const cfg = connection
    ? {
        winuaePath: connection.getSessionInfo().winuaePath,
        configFile: connection.getSessionInfo().configFile,
        gdbPort: connection.getSessionInfo().gdbPort,
      }
    : getBaseConfigForArgs(args);

  const candidate = new WinUAEConnection(cfg);
  if (connection) {
    cloneConnectionState(connection, candidate);
  }

  try {
    await candidate.connectExisting();
    connection = candidate;
    connection.markActivity(`auto_attach:${name}`);
  } catch {
    // Fall through; the tool-specific handler will raise the normal "Not connected" error.
  }
}

// ─── Amiga Custom Register Name Table ────────────────────────────────

const CUSTOM_REGS: Record<number, string> = {
  0x000: 'BLTDDAT', 0x002: 'DMACONR', 0x004: 'VPOSR', 0x006: 'VHPOSR',
  0x008: 'DSKDATR', 0x00A: 'JOY0DAT', 0x00C: 'JOY1DAT', 0x00E: 'CLXDAT',
  0x010: 'ADKCONR', 0x012: 'POT0DAT', 0x014: 'POT1DAT', 0x016: 'POTGOR',
  0x018: 'SERDATR', 0x01A: 'DSKBYTR', 0x01C: 'INTENAR', 0x01E: 'INTREQR',
  0x020: 'DSKPTH', 0x022: 'DSKPTL', 0x024: 'DSKLEN', 0x026: 'DSKDAT',
  0x028: 'REFPTR', 0x02A: 'VPOSW', 0x02C: 'VHPOSW', 0x02E: 'COPCON',
  0x030: 'SERDAT', 0x032: 'SERPER', 0x034: 'POTGO', 0x036: 'JOYTEST',
  0x038: 'STREQU', 0x03A: 'STRVBL', 0x03C: 'STRHOR', 0x03E: 'STRLONG',
  0x040: 'BLTCON0', 0x042: 'BLTCON1', 0x044: 'BLTAFWM', 0x046: 'BLTALWM',
  0x048: 'BLTCPTH', 0x04A: 'BLTCPTL', 0x04C: 'BLTBPTH', 0x04E: 'BLTBPTL',
  0x050: 'BLTAPTH', 0x052: 'BLTAPTL', 0x054: 'BLTDPTH', 0x056: 'BLTDPTL',
  0x058: 'BLTSIZE', 0x05A: 'BLTCON0L', 0x05C: 'BLTSIZV', 0x05E: 'BLTSIZH',
  0x060: 'BLTCMOD', 0x062: 'BLTBMOD', 0x064: 'BLTAMOD', 0x066: 'BLTDMOD',
  0x070: 'BLTCDAT', 0x072: 'BLTBDAT', 0x074: 'BLTADAT',
  0x078: 'SPRHDAT', 0x07C: 'DENISEID',
  0x07E: 'DSKSYNC',
  0x080: 'COP1LCH', 0x082: 'COP1LCL', 0x084: 'COP2LCH', 0x086: 'COP2LCL',
  0x088: 'COPJMP1', 0x08A: 'COPJMP2', 0x08C: 'COPINS',
  0x08E: 'DIWSTRT', 0x090: 'DIWSTOP', 0x092: 'DDFSTRT', 0x094: 'DDFSTOP',
  0x096: 'DMACON', 0x098: 'CLXCON', 0x09A: 'INTENA', 0x09C: 'INTREQ',
  0x09E: 'ADKCON',
  0x0A0: 'AUD0LCH', 0x0A2: 'AUD0LCL', 0x0A4: 'AUD0LEN', 0x0A6: 'AUD0PER',
  0x0A8: 'AUD0VOL', 0x0AA: 'AUD0DAT',
  0x0B0: 'AUD1LCH', 0x0B2: 'AUD1LCL', 0x0B4: 'AUD1LEN', 0x0B6: 'AUD1PER',
  0x0B8: 'AUD1VOL', 0x0BA: 'AUD1DAT',
  0x0C0: 'AUD2LCH', 0x0C2: 'AUD2LCL', 0x0C4: 'AUD2LEN', 0x0C6: 'AUD2PER',
  0x0C8: 'AUD2VOL', 0x0CA: 'AUD2DAT',
  0x0D0: 'AUD3LCH', 0x0D2: 'AUD3LCL', 0x0D4: 'AUD3LEN', 0x0D6: 'AUD3PER',
  0x0D8: 'AUD3VOL', 0x0DA: 'AUD3DAT',
  0x0E0: 'BPL1PTH', 0x0E2: 'BPL1PTL', 0x0E4: 'BPL2PTH', 0x0E6: 'BPL2PTL',
  0x0E8: 'BPL3PTH', 0x0EA: 'BPL3PTL', 0x0EC: 'BPL4PTH', 0x0EE: 'BPL4PTL',
  0x0F0: 'BPL5PTH', 0x0F2: 'BPL5PTL', 0x0F4: 'BPL6PTH', 0x0F6: 'BPL6PTL',
  0x100: 'BPLCON0', 0x102: 'BPLCON1', 0x104: 'BPLCON2', 0x106: 'BPLCON3',
  0x108: 'BPL1MOD', 0x10A: 'BPL2MOD',
  0x110: 'BPL1DAT', 0x112: 'BPL2DAT', 0x114: 'BPL3DAT', 0x116: 'BPL4DAT',
  0x118: 'BPL5DAT', 0x11A: 'BPL6DAT',
  0x120: 'SPR0PTH', 0x122: 'SPR0PTL', 0x124: 'SPR1PTH', 0x126: 'SPR1PTL',
  0x128: 'SPR2PTH', 0x12A: 'SPR2PTL', 0x12C: 'SPR3PTH', 0x12E: 'SPR3PTL',
  0x130: 'SPR4PTH', 0x132: 'SPR4PTL', 0x134: 'SPR5PTH', 0x136: 'SPR5PTL',
  0x138: 'SPR6PTH', 0x13A: 'SPR6PTL', 0x13C: 'SPR7PTH', 0x13E: 'SPR7PTL',
  0x140: 'SPR0POS', 0x142: 'SPR0CTL', 0x144: 'SPR0DATA', 0x146: 'SPR0DATB',
  0x148: 'SPR1POS', 0x14A: 'SPR1CTL', 0x14C: 'SPR1DATA', 0x14E: 'SPR1DATB',
  0x150: 'SPR2POS', 0x152: 'SPR2CTL', 0x154: 'SPR2DATA', 0x156: 'SPR2DATB',
  0x158: 'SPR3POS', 0x15A: 'SPR3CTL', 0x15C: 'SPR3DATA', 0x15E: 'SPR3DATB',
  0x160: 'SPR4POS', 0x162: 'SPR4CTL', 0x164: 'SPR4DATA', 0x166: 'SPR4DATB',
  0x168: 'SPR5POS', 0x16A: 'SPR5CTL', 0x16C: 'SPR5DATA', 0x16E: 'SPR5DATB',
  0x170: 'SPR6POS', 0x172: 'SPR6CTL', 0x174: 'SPR6DATA', 0x176: 'SPR6DATB',
  0x178: 'SPR7POS', 0x17A: 'SPR7CTL', 0x17C: 'SPR7DATA', 0x17E: 'SPR7DATB',
  0x180: 'COLOR00', 0x182: 'COLOR01', 0x184: 'COLOR02', 0x186: 'COLOR03',
  0x188: 'COLOR04', 0x18A: 'COLOR05', 0x18C: 'COLOR06', 0x18E: 'COLOR07',
  0x190: 'COLOR08', 0x192: 'COLOR09', 0x194: 'COLOR10', 0x196: 'COLOR11',
  0x198: 'COLOR12', 0x19A: 'COLOR13', 0x19C: 'COLOR14', 0x19E: 'COLOR15',
  0x1A0: 'COLOR16', 0x1A2: 'COLOR17', 0x1A4: 'COLOR18', 0x1A6: 'COLOR19',
  0x1A8: 'COLOR20', 0x1AA: 'COLOR21', 0x1AC: 'COLOR22', 0x1AE: 'COLOR23',
  0x1B0: 'COLOR24', 0x1B2: 'COLOR25', 0x1B4: 'COLOR26', 0x1B6: 'COLOR27',
  0x1B8: 'COLOR28', 0x1BA: 'COLOR29', 0x1BC: 'COLOR30', 0x1BE: 'COLOR31',
  0x1C0: 'HTOTAL', 0x1C2: 'HSSTOP', 0x1C4: 'HBSTRT', 0x1C6: 'HBSTOP',
  0x1C8: 'VTOTAL', 0x1CA: 'VSSTOP', 0x1CC: 'VBSTRT', 0x1CE: 'VBSTOP',
  0x1DC: 'BEAMCON0', 0x1DE: 'HSSTRT', 0x1E0: 'VSSTRT', 0x1E2: 'HCENTER',
  0x1E4: 'DIWHIGH', 0x1FE: 'NO-OP',
};

// m68k opcode table (first word) for basic disassembly
const M68K_OPCODES: Record<number, string> = {
  0x4E75: 'RTS', 0x4E73: 'RTE', 0x4E71: 'NOP', 0x4E72: 'STOP',
  0x4E70: 'RESET', 0x4AFC: 'ILLEGAL', 0x4E77: 'RTR',
};

// ─── Helper Functions ────────────────────────────────────────────────

function parseHexOrDecimal(value: string | number): number {
  if (typeof value === 'number') return value;
  const s = value.trim();
  let result: number;
  if (s.startsWith('$')) result = parseInt(s.slice(1), 16);
  else if (s.startsWith('0x') || s.startsWith('0X')) result = parseInt(s.slice(2), 16);
  else result = parseInt(s, 10);
  if (isNaN(result)) throw new Error(`Invalid address/value: "${value}"`);
  return result;
}

function hex32(v: number): string {
  return '$' + (v >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function hex16(v: number): string {
  return '$' + (v & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
}

function hex8(v: number): string {
  return '$' + (v & 0xFF).toString(16).padStart(2, '0').toUpperCase();
}

function hexDump(data: Buffer, startAddr: number, bytesPerLine: number = 16): string {
  let result = '';
  for (let i = 0; i < data.length; i += bytesPerLine) {
    const addr = startAddr + i;
    const line = data.subarray(i, Math.min(i + bytesPerLine, data.length));

    result += `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}  `;

    const hexPart = Array.from(line)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    result += hexPart.padEnd(bytesPerLine * 3, ' ');

    result += ' |';
    for (const byte of line) {
      result += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
    }
    result += '|\n';
  }
  return result;
}

// `memory-map` reply: {"addressing","truncated","regions":[{address,size,type,chip,name}]}
function parseMonitorMemoryMap(reply: any): Array<{
  name: string;
  start: string;
  end: string;
  size: number;
  type: string;
  chip: boolean;
}> {
  const regions: any[] = Array.isArray(reply?.regions) ? reply.regions : [];
  return regions.map((r) => ({
    name: String(r.name ?? ''),
    start: hex32(Number(r.address) >>> 0),
    end: hex32((Number(r.address) + Number(r.size) - 1) >>> 0),
    size: Number(r.size) >>> 0,
    type: String(r.type ?? ''),
    chip: r.chip === true,
  }));
}

/** Upstream monitor numbers are hex, without a prefix. */
function mhex(v: number): string {
  return (v >>> 0).toString(16);
}

// watch source filters -> MW_MASK_* bits (include/debug.h)
const WATCH_SOURCE_MASKS: Record<string, number> = {
  all: 0x7ffffffe, // MW_MASK_ALL minus instruction fetch
  cpu: 0x2 | 0x4, cpud: 0x2 | 0x4, cpudr: 0x2, cpudw: 0x4,
  blitter: 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100,
  copper: 0x200, disk: 0x400,
  audio: 0x800 | 0x1000 | 0x2000 | 0x4000,
  audio0: 0x800, audio1: 0x1000, audio2: 0x2000, audio3: 0x4000,
  bpl: 0x8000 | 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x200000 | 0x400000,
  bpl0: 0x8000, bpl1: 0x10000, bpl2: 0x20000, bpl3: 0x40000, bpl4: 0x80000, bpl5: 0x100000, bpl6: 0x200000, bpl7: 0x400000,
  spr: 0x800000 | 0x1000000 | 0x2000000 | 0x4000000 | 0x8000000 | 0x10000000 | 0x20000000 | 0x40000000,
  spr0: 0x800000, spr1: 0x1000000, spr2: 0x2000000, spr3: 0x4000000, spr4: 0x8000000, spr5: 0x10000000, spr6: 0x20000000, spr7: 0x40000000,
};
WATCH_SOURCE_MASKS.dma = WATCH_SOURCE_MASKS.all & ~0x6;

/** Resolve the current (or given) AmigaDOS process's LoadSeg segments. */
async function readSegments(protocol: GdbProtocol, processAddr?: number): Promise<{
  process: number; name: string; command: string; segments: Array<{ index: number; address: number; size: number }>;
}> {
  const cmd = processAddr !== undefined ? `segments ${mhex(processAddr)}` : 'segments';
  const reply = await protocol.sendMonitorJson(cmd, 10000);
  return {
    process: Number(reply?.process) >>> 0,
    name: String(reply?.name ?? ''),
    command: String(reply?.command ?? ''),
    segments: Array.isArray(reply?.segments) ? reply.segments.map((g: any) => ({
      index: Number(g.index), address: Number(g.address) >>> 0, size: Number(g.size) >>> 0,
    })) : [],
  };
}

function formatRegisters(regs: M68kRegisters): string {
  const lines: string[] = [];

  // Data registers
  const dRegs = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'] as const;
  lines.push(dRegs.map(r => `${r}=${hex32(regs[r])}`).join(' '));

  // Address registers
  const aRegs = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const;
  lines.push(aRegs.map(r => `${r}=${hex32(regs[r])}`).join(' '));

  // SR and PC
  const sr = regs.SR;
  const srFlags = [
    (sr & 0x8000) ? 'T1' : '',
    (sr & 0x4000) ? 'T0' : '',
    (sr & 0x2000) ? 'S' : '',
    (sr & 0x1000) ? 'M' : '',
    `IPL=${(sr >> 8) & 7}`,
    (sr & 0x10) ? 'X' : 'x',
    (sr & 0x08) ? 'N' : 'n',
    (sr & 0x04) ? 'Z' : 'z',
    (sr & 0x02) ? 'V' : 'v',
    (sr & 0x01) ? 'C' : 'c',
  ].filter(s => s).join(' ');

  lines.push(`PC=${hex32(regs.PC)} SR=${hex16(regs.SR)} [${srFlags}]`);

  return lines.join('\n');
}

function isTransientWinUaeTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message ?? '';
  const code = (error as { code?: string }).code;
  return code === 'ECONNRESET' ||
    message.includes('ECONNRESET') ||
    message.includes('Disconnected') ||
    message.includes('Socket closed');
}

async function readCustomRegisterData(
  protocol: GdbProtocol,
  propagateTransientErrors: boolean = false
): Promise<{ data: Buffer; unreadableChunkOffsets: number[] }> {
  const chunks: Buffer[] = [];
  const unreadableChunkOffsets: number[] = [];

  for (let off = 0; off < CUSTOM_REGISTER_SIZE; off += CUSTOM_REGISTER_CHUNK_SIZE) {
    try {
      chunks.push(await protocol.readMemory(0xDFF000 + off, CUSTOM_REGISTER_CHUNK_SIZE));
    } catch (error) {
      if (propagateTransientErrors && isTransientWinUaeTransportError(error)) {
        throw error;
      }
      unreadableChunkOffsets.push(off);
      chunks.push(Buffer.alloc(CUSTOM_REGISTER_CHUNK_SIZE, 0));
    }
  }

  return {
    data: Buffer.concat(chunks),
    unreadableChunkOffsets,
  };
}

/**
 * Decode Copper list from raw memory
 */
function decodeCopperList(data: Buffer, baseAddr: number): string {
  const lines: string[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const addr = baseAddr + i;
    const word1 = data.readUInt16BE(i);
    const word2 = data.readUInt16BE(i + 2);

    const addrStr = `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;

    if (word1 === 0xFFFF && word2 === 0xFFFE) {
      lines.push(`${addrStr}  END`);
      break;
    }

    if (word1 & 1) {
      // WAIT or SKIP instruction
      const vp = (word1 >> 8) & 0xFF;
      const hp = word1 & 0xFE;
      const ve = (word2 >> 8) & 0x7F;
      const he = word2 & 0xFE;
      const bfd = (word2 & 0x8000) ? '' : ' (BFD=0, blitter finish disable)';

      if (word2 & 1) {
        lines.push(`${addrStr}  SKIP  VP>=${hex8(vp)} HP>=${hex8(hp)} VE=${hex8(ve)} HE=${hex8(he)}${bfd}`);
      } else {
        lines.push(`${addrStr}  WAIT  VP>=${hex8(vp)} HP>=${hex8(hp)} VE=${hex8(ve)} HE=${hex8(he)}${bfd}`);
      }
    } else {
      // MOVE instruction
      const regOffset = word1 & 0x1FE;
      const regName = CUSTOM_REGS[regOffset] || `REG_${regOffset.toString(16).padStart(3, '0')}`;
      lines.push(`${addrStr}  MOVE  ${regName} (#${hex16(word2)})`);
    }
  }
  return lines.join('\n');
}

/**
 * Simple m68k disassembly (opcode word only — shows hex for unknown)
 */
function disassembleM68k(data: Buffer, baseAddr: number, count: number): string {
  const lines: string[] = [];
  let offset = 0;
  for (let i = 0; i < count && offset + 1 < data.length; i++) {
    const addr = baseAddr + offset;
    const word = data.readUInt16BE(offset);
    const addrStr = `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
    const wordHex = word.toString(16).padStart(4, '0').toUpperCase();

    const known = M68K_OPCODES[word];
    if (known) {
      lines.push(`${addrStr}  ${wordHex}        ${known}`);
      offset += 2;
    } else {
      // Show raw word — proper disassembly would need a full decoder
      lines.push(`${addrStr}  ${wordHex}        DC.W $${wordHex}`);
      offset += 2;
    }
  }
  return lines.join('\n');
}

// ─── Disk Image Detection ────────────────────────────────────────────

const DISK_IMAGE_EXTENSIONS = new Set(['.adf', '.adz', '.dms', '.ipf', '.fdi', '.scp', '.zip']);

function isDiskImage(filePath: string): boolean {
  return DISK_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ─── Tool Definitions ────────────────────────────────────────────────

const tools: Tool[] = [
  // Connection tools
  {
    name: 'winuae_connect',
    description: 'Launch WinUAE with its built-in GDB server (debugging_features=gdbserver) and connect over GDB RSP. Must be called before any other WinUAE commands. Set WINUAE_PATH and WINUAE_CONFIG env vars, or pass config_file for a one-off .uae path.',
    inputSchema: {
      type: 'object',
      properties: {
        config_file: {
          type: 'string',
          description: 'Optional absolute path to a WinUAE .uae file (overrides WINUAE_CONFIG for this session).',
        },
        idle_timeout_ms: {
          type: 'number',
          description: 'Optional reusable-session idle timeout in milliseconds. 0 disables auto-disconnect.',
        },
        idle_action: {
          type: 'string',
          enum: ['detach', 'shutdown'],
          description: 'Optional idle action. detach leaves WinUAE running, shutdown closes the launched emulator process.',
        },
        force_break: {
          type: 'boolean',
          description: 'If false, connect without sending an initial Ctrl+C. Useful for non-intrusive ADF/disk boot observation.',
          default: true,
        },
        initialize_stopped: {
          type: 'boolean',
          description: 'If false, skip initial halt-state queries that assume the target is already stopped. Usually pair with force_break=false.',
          default: true,
        },
      },
    },
  },
  {
    name: 'winuae_connect_existing',
    description: 'Connect to an already-running WinUAE GDB server (port 2345). Do not start WinUAE. Use when WinUAE was started by F5 or by a script; then use breakpoints/memory/step without calling winuae_load.',
    inputSchema: {
      type: 'object',
      properties: {
        config_file: {
          type: 'string',
          description: 'Ignored for hardware (emulator already running); reserved for future use / logging.',
        },
        idle_timeout_ms: {
          type: 'number',
          description: 'Optional reusable-session idle timeout in milliseconds. 0 disables auto-disconnect.',
        },
        idle_action: {
          type: 'string',
          enum: ['detach', 'shutdown'],
          description: 'Optional idle action. detach leaves WinUAE running, shutdown closes the launched emulator process if this MCP started it.',
        },
        force_break: {
          type: 'boolean',
          description: 'If false, attach without sending an initial Ctrl+C. Useful to observe an already-running boot sequence non-intrusively.',
          default: true,
        },
        initialize_stopped: {
          type: 'boolean',
          description: 'If false, skip initial halt-state queries that assume the target is already stopped. Usually pair with force_break=false.',
          default: true,
        },
      },
    },
  },
  {
    name: 'winuae_disconnect',
    description: 'Disconnect from WinUAE. By default also stops the launched emulator process; set stop_emulator=false to detach and leave the window running.',
    inputSchema: {
      type: 'object',
      properties: {
        stop_emulator: {
          type: 'boolean',
          description: 'If false, only disconnect GDB and leave the emulator process running.',
          default: true,
        },
      },
    },
  },
  {
    name: 'winuae_status',
    description: 'Return JSON session status, health, tracked floppies, and reusable-session policy.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_session_config',
    description: 'Configure reusable WinUAE session behavior. idle_timeout_ms=0 disables auto-disconnect. idle_action=detach leaves WinUAE running after idle expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        idle_timeout_ms: {
          type: 'number',
          description: 'Idle timeout in milliseconds before automatic disconnect. 0 disables the timer.',
          default: 0,
        },
        idle_action: {
          type: 'string',
          enum: ['detach', 'shutdown'],
          description: 'detach leaves WinUAE running and only drops GDB; shutdown also closes the launched emulator process.',
          default: 'detach',
        },
      },
    },
  },
  {
    name: 'winuae_memory_map',
    description: 'Return the current Amiga memory-bank map as JSON parsed from the WinUAE monitor. Useful before fixed-address loads to confirm Chip/Bogo/Fast RAM ranges are mapped.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_qoffsets',
    description: 'Return the LoadSeg segments of the current AmigaDOS process (or of the process at `process`), from the server\'s `segments` monitor command. `text` is the first segment\'s data start, the value qOffsets used to report; resolve ELF symbols against it.',
    inputSchema: {
      type: 'object',
      properties: {
        process: { type: ['string', 'number'], description: 'Optional Process structure address (hex or decimal). Default: the current task.' },
      },
    },
  },

  // Load/Reset
  {
    name: 'winuae_load',
    description: 'Load an Amiga executable into memory by writing it via GDB. Provide the host path to the compiled binary. For disk images (ADF, ZIP, ADZ, DMS, IPF), inserts into DF0: and restarts. ADF is the native Amiga disk image format; ZIP files are opened by WinUAE and the first disk image inside is used.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to Amiga executable on host filesystem',
        },
        address: {
          type: ['string', 'number'],
          description: 'Load address in Amiga memory (default: $4000). Use $ prefix for hex.',
          default: 0x4000,
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'winuae_reset',
    description: 'Reset the Amiga by restarting WinUAE with current configuration (hard reset). Reconnects GDB automatically.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Warp/turbo mode control
  {
    name: 'winuae_warp',
    description: 'Control warp/turbo mode to run emulation at maximum speed (useful for fast loading, skipping intros). Mode: 1/on = enable turbo, 0/off = disable turbo, status = check current state. In warp mode, audio is disabled and emulation runs as fast as the host CPU allows.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['on', 'off', '1', '0', 'status'],
          description: 'Warp mode: on/1 = enable turbo, off/0 = normal speed, status = query state',
          default: 'status',
        },
      },
    },
  },

  // Disk tools
  {
    name: 'winuae_insert_disk',
    description: 'Insert a floppy disk image (ADF Amiga Disk File, ADZ, DMS, IPF, ZIP) into a drive. ADF is the standard Amiga format. ZIP: WinUAE uses the first image inside. Use drive 0 for DF0: (boot drive).',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to disk image file (e.g. .adf Amiga Disk File, .zip, .adz, .dms, .ipf)',
        },
        drive: {
          type: 'number',
          description: 'Drive number 0-3 (default: 0 = DF0:)',
          default: 0,
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'winuae_eject_disk',
    description: 'Eject floppy disk from a drive. When connected, uses monitor command (hot-swap, no restart); otherwise clears the drive for next winuae_connect.',
    inputSchema: {
      type: 'object',
      properties: {
        drive: {
          type: 'number',
          description: 'Drive number 0-3 (default: 0 = DF0:)',
          default: 0,
        },
      },
    },
  },


  {
    name: 'winuae_profile_ollama',
    description: 'Captura un perfil por el CANAL LATERAL (2346, sin tocar GDB), extrae frames + resumen tecnico y lo analiza con Ollama LOCAL (sin tokens de nube). Devuelve un informe markdown con la descripcion fiel de lo que se renderiza (vision) y el pre-analisis tecnico (registros custom, DMA, bitplanes, ciclos). Uso tipico: verificar si lo que se ve encaja con lo que se pretendia crear (p.ej. tiles de un scroll montandose bien). Requiere WinUAE-DBG corriendo con el canal lateral activo y Ollama local en 127.0.0.1:11434.',
    inputSchema: {
      type: 'object',
      properties: {
        num_frames: {
          type: 'number',
          description: 'Numero de frames a capturar (1-100, default 4)',
          default: 4,
        },
        out_dir: {
          type: 'string',
          description: 'Directorio host donde se deja el .bin, los frames y el informe. Default: temp con timestamp.',
        },
        prompt: {
          type: 'string',
          description: 'Que se espera ver (intencion del programador), p.ej. "scroll horizontal fino, comprobar que los tiles se ensamblan sin salto de 16px". Se anade al prompt generico.',
        },
        prompt_file: {
          type: 'string',
          description: 'Ruta a un fichero de prompt personalizado (sustituye al generico).',
        },
        model: {
          type: 'string',
          description: 'Modelo de vision Ollama (default qwen3-vl:8b-instruct-q8_0)',
        },
        text_model: {
          type: 'string',
          description: 'Modelo de texto Ollama para el pre-analisis tecnico (default qwen3:8b)',
        },
        base: {
          type: 'string',
          description: 'URL base de Ollama (default http://127.0.0.1:11434)',
        },
        mode: {
          type: 'string',
          enum: ['meta', 'frames', 'montage', 'all'],
          description: 'meta=tecnico sin imagenes; frames=por frame; montage=hoja de contacto; all=meta+montage (default).',
          default: 'all',
        },
        frames: {
          type: 'string',
          description: 'Subconjunto de frames a analizar con vision (p.ej. "0,1,2"). Default: todos.',
        },
        wait_cmd: {
          type: 'string',
          description: 'Comando del canal lateral que se repite hasta que wait_contains aparezca antes de capturar (p.ej. "runstatus 0x<addr>").',
        },
        wait_contains: {
          type: 'string',
          description: 'Texto que debe aparecer en la respuesta de wait_cmd para empezar a capturar (p.ej. "READY").',
        },
        side_port: {
          type: 'number',
          description: 'Puerto del canal lateral (default 2346)',
          default: 2346,
        },
      },
    },
  },

  // Memory tools (core: use these for graphics/audio extraction, search, and hardware toggles)
  {
    name: 'winuae_memory_read',
    description: 'Read memory bytes; returns hex. Use for: (1) dumping bitplane data (address from BPL1PTH/L in custom regs, length = row_bytes × height × num_planes), (2) dumping Paula samples (address from AUDxLCH/L, length from AUDxLEN in words × 2), (3) searching for patterns by reading chunks and inspecting hex. Address/length support $ or 0x hex.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address (use $ for hex, e.g., $DFF000)',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to read',
        },
      },
      required: ['address', 'length'],
    },
  },
  {
    name: 'winuae_memory_write',
    description: 'Write bytes to memory (hex string). Use to change custom registers: write 2 bytes big-endian to $DFF000+offset. E.g. BPLCON0=$DFF100 (offset 0x100): set value to enable/disable bitplanes; DMACON=$DFF096 (0x096): bit 9=sprites, bit 8=bitplanes — clear bits to hide. Enables coppenheimer-style toggles without extra tools.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address (e.g. $DFF100 for BPLCON0, $DFF096 for DMACON)',
        },
        data: {
          type: 'string',
          description: 'Hex data to write (2 bytes for a single register, e.g. 0200)',
        },
      },
      required: ['address', 'data'],
    },
  },
  {
    name: 'winuae_memory_dump',
    description: 'Dump memory as hex+ASCII (hex editor style). Use to inspect custom regs, Copper lists, or any region. For pattern search: read chunks with memory_read and check the returned hex, or dump a range and search in the output.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to dump',
        },
        bytesPerLine: {
          type: 'number',
          description: 'Bytes per line (default: 16)',
          default: 16,
        },
      },
      required: ['address', 'length'],
    },
  },

  // Register tools
  {
    name: 'winuae_registers_get',
    description: 'Get all m68k CPU registers: D0-D7, A0-A7, SR, PC',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_registers_set',
    description: 'Set m68k CPU registers. Provide any subset of D0-D7, A0-A7, SR, PC.',
    inputSchema: {
      type: 'object',
      properties: {
        D0: { type: ['string', 'number'], description: 'D0 register' },
        D1: { type: ['string', 'number'], description: 'D1 register' },
        D2: { type: ['string', 'number'], description: 'D2 register' },
        D3: { type: ['string', 'number'], description: 'D3 register' },
        D4: { type: ['string', 'number'], description: 'D4 register' },
        D5: { type: ['string', 'number'], description: 'D5 register' },
        D6: { type: ['string', 'number'], description: 'D6 register' },
        D7: { type: ['string', 'number'], description: 'D7 register' },
        A0: { type: ['string', 'number'], description: 'A0 register' },
        A1: { type: ['string', 'number'], description: 'A1 register' },
        A2: { type: ['string', 'number'], description: 'A2 register' },
        A3: { type: ['string', 'number'], description: 'A3 register' },
        A4: { type: ['string', 'number'], description: 'A4 register' },
        A5: { type: ['string', 'number'], description: 'A5 register' },
        A6: { type: ['string', 'number'], description: 'A6 register' },
        A7: { type: ['string', 'number'], description: 'A7 register (SP)' },
        SR: { type: ['string', 'number'], description: 'Status Register' },
        PC: { type: ['string', 'number'], description: 'Program Counter' },
      },
    },
  },

  // Breakpoints
  {
    name: 'winuae_breakpoint_set',
    description: 'Set a software breakpoint at address. Execution stops when PC reaches this address.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address to break at',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_breakpoint_clear',
    description: 'Remove a breakpoint at address',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address of breakpoint to remove',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_breakpoint_conditional_wait',
    description: 'Software-assisted conditional breakpoint helper. Sets a breakpoint at an address, continues execution, and only returns when all requested register/custom/memory conditions match on a stop. This is not native stub-side conditional breakpoint support.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address to break at while evaluating conditions.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Total timeout budget in milliseconds across all hits (default: 30000).',
          default: 30000,
        },
        max_hits: {
          type: 'number',
          description: 'Maximum breakpoint hits to inspect before returning unmatched (default: 32).',
          default: 32,
        },
        auto_clear: {
          type: 'boolean',
          description: 'Clear the temporary breakpoint before returning (default: true).',
          default: true,
        },
        register_equals: {
          type: 'object',
          description: 'Map of CPU register names to exact values, for example { "D0": "$1", "PC": "$4000" }.',
          additionalProperties: {
            type: ['string', 'number'],
          },
        },
        register_mask_equals: {
          type: 'array',
          description: 'Array of masked register comparisons. Each entry checks (register & mask) === value.',
          items: {
            type: 'object',
            properties: {
              register: { type: 'string' },
              mask: { type: ['string', 'number'] },
              value: { type: ['string', 'number'] },
            },
            required: ['register', 'mask', 'value'],
          },
        },
        memory_equals: {
          type: 'array',
          description: 'Array of exact memory byte checks at stop time.',
          items: {
            type: 'object',
            properties: {
              address: { type: ['string', 'number'] },
              value_hex: { type: 'string' },
            },
            required: ['address', 'value_hex'],
          },
        },
        custom_equals: {
          type: 'array',
          description: 'Array of exact custom register checks. Use either name (for example DMACON) or offset (for example $096).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              offset: { type: ['string', 'number'] },
              value: { type: ['string', 'number'] },
            },
            required: ['value'],
          },
        },
      },
      required: ['address'],
    },
  },

  // Watchpoints
  {
    name: 'winuae_watchpoint_set',
    description: 'Set a watchpoint to break on memory read/write/access.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of watched range',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to watch',
        },
        type: {
          type: 'string',
          enum: ['read', 'write', 'access'],
          description: 'Type of access to watch for',
        },
      },
      required: ['address', 'length', 'type'],
    },
  },
  {
    name: 'winuae_watchpoint_clear',
    description: 'Remove a watchpoint',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of watchpoint to remove',
        },
        length: {
          type: 'number',
          description: 'Length of watchpoint to remove',
        },
        type: {
          type: 'string',
          enum: ['read', 'write', 'access'],
          description: 'Type of watchpoint to remove',
        },
      },
      required: ['address', 'length', 'type'],
    },
  },

  // WinUAE-DBG v2.1 monitor extensions (e9k-style)
  {
    name: 'winuae_emulator_status',
    description: 'Return emulator telemetry: execution state (running/stopped/host-paused), frame, vpos/hpos, cycles, warp, and the display resolution. Works while the CPU runs (monitor `execution-status` + `warp`).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'winuae_watchpoint_set_ext',
    description: 'Set a watchpoint with a source filter and optional value predicates (monitor `watch add`/`watch range`). Breaks (or only logs, with nobreak) on matching accesses. size 8/16/32 watches one aligned access of that width; length watches any access overlapping a byte range instead. Hits are logged; read them with winuae_watchpoint_last.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: ['string', 'number'], description: 'Start address (hex or decimal)' },
        access: { type: 'string', enum: ['r', 'w', 'rw', 'x'], description: 'Access to watch (default rw). x = instruction fetch, range watches only' },
        size: { type: 'number', enum: [8, 16, 32], description: 'Exact watch width in bits (default 32). Ignored when length is given' },
        length: { type: 'number', description: 'Watch a byte range of this length (1..65536) instead of one exact access' },
        value: { type: ['string', 'number'], description: 'Only match if the accessed value matches this (hex or decimal)' },
        mask: { type: ['string', 'number'], description: 'Value mask for the value comparison (default 0xffffffff)' },
        must_change: { type: 'boolean', description: 'Only match writes that change the value (exact watches on RAM only)' },
        source: { type: 'string', enum: Object.keys(WATCH_SOURCE_MASKS), description: 'Filter by access source (default all = everything but instruction fetch)' },
        nobreak: { type: 'boolean', description: 'Do not stop emulation, only log the hit' },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_watchpoint_last',
    description: 'Return the most recent watchpoint hit from the server\'s 64-entry event log (address, access, size, source, value, old value, PC). all=true returns the whole log; clear=true empties it after reading.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Return every logged event, not just the last' },
        clear: { type: 'boolean', description: 'Empty the event log (returns what it held)' },
      },
    },
  },
  {
    name: 'winuae_watchpoint_list',
    description: 'List watchpoints set with winuae_watchpoint_set_ext (monitor `watch list`), with their ids.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'winuae_watchpoint_clear_ext',
    description: 'Clear watchpoints set with winuae_watchpoint_set_ext. Pass idx (the id from winuae_watchpoint_list) to remove one, or all=true to remove every one.',
    inputSchema: {
      type: 'object',
      properties: {
        idx: { type: 'number', description: 'Watchpoint id to remove (from winuae_watchpoint_list)' },
        all: { type: 'boolean', description: 'Clear all watchpoints' },
      },
    },
  },
  {
    name: 'winuae_trace',
    description: 'Instruction history (monitor `history`). on starts recording every executed instruction, off stops, read returns the last `count` entries (pc, frame, vpos, hpos, D0-A7), oldest first. Recording slows emulation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'read'], description: 'on/off/read (default read)' },
        count: { type: 'number', description: 'Entries to read, 1..128 (default 32)' },
      },
    },
  },

  // Execution control
  {
    name: 'winuae_base',
    description: 'Report the runtime segment bases of the current AmigaDOS process (or of `process`), from the `segments` monitor command: sec0 = first LoadSeg segment (usually .text), sec1, ... in load order. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        process: { type: ['string', 'number'], description: 'Optional Process structure address. Default: the current task.' },
      },
    },
  },
  {
    name: 'winuae_print',
    description: 'Print a value from emulated memory (e9k-style). Accepts an address (`0x...`) or a symbol resolved via the demo `.map` (mapPath). `size` selects 8/16/32 bits. Prefix * to treat the value as a pointer and print what it points to. Resolution: linked symbol -> runtime via the process segments (monitor `segments`).',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'Address (0x...) or symbol name (requires mapPath). Prefix * for dereference.' },
        size: { type: 'number', enum: [8, 16, 32], description: 'Access size (default 32)' },
        mapPath: { type: 'string', description: 'Path to the demo .map to resolve symbols (e.g. out/demos/101_ehb_tile_scroll_driver/101_ehb_tile_scroll_driver.map)' },
      },
      required: ['expr'],
    },
  },
  {
    name: 'winuae_step',
    description: 'Single-step N instructions. Returns registers after stepping.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of instructions to step (default: 1)',
          default: 1,
        },
      },
    },
  },
  {
    name: 'winuae_continue',
    description: 'Resume execution. Will stop at next breakpoint/watchpoint.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_pause',
    description: 'Pause/break execution (send interrupt to CPU)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_wait_stop',
    description: 'Wait for execution to stop (e.g. after winuae_continue, when a breakpoint is hit). Call this after winuae_continue so breakpoints actually stop the CPU. Returns stop reason and registers.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: {
          type: 'number',
          description: 'Max ms to wait (default 30000)',
          default: 30000,
        },
      },
    },
  },
  {
    name: 'winuae_postmortem_capture',
    description: 'Capture a postmortem bundle after a crash, requester, or suspicious stop: CPU registers, parsed stop reason, stack dump, disassembly around PC, and optional custom/chip snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        stop_reply: {
          type: 'string',
          description: 'Optional raw stop reply from winuae_pause / winuae_wait_stop, such as S04 or T05thread:....',
        },
        stack_bytes: {
          type: 'number',
          description: 'Bytes to dump from A7/SP (default 128, max 1024).',
          default: 128,
        },
        disasm_count: {
          type: 'number',
          description: 'Instructions/lines requested around PC from the monitor disassembler (default 12).',
          default: 12,
        },
        include_custom: {
          type: 'boolean',
          description: 'Include current custom register snapshot (default true).',
          default: true,
        },
        include_chip_window: {
          type: 'boolean',
          description: 'Include a bounded chip RAM window in the snapshot.',
          default: false,
        },
        chip_window_address: {
          type: ['string', 'number'],
          description: 'Optional chip RAM window base address (default $000000).',
        },
        chip_window_bytes: {
          type: 'number',
          description: 'Chip RAM bytes to include when include_chip_window=true (default 1024).',
          default: 1024,
        },
        markdown_file: {
          type: 'string',
          description: 'Optional host path where a Markdown summary should be written.',
        },
        json_file: {
          type: 'string',
          description: 'Optional host path where JSON should be written.',
        },
      },
    },
  },
  {
    name: 'winuae_postmortem_capture',
    description: 'Capture a postmortem bundle from the current stopped state: registers, optional custom/custom-chip snapshot, disassembly around PC, stack dump from A7, and optional RAM window. Useful after crashes, requesters, or suspicious stops.',
    inputSchema: {
      type: 'object',
      properties: {
        stop_reply: {
          type: 'string',
          description: 'Optional stop reply text already known by the caller.',
        },
        disasm_count: {
          type: 'number',
          description: 'Instructions to disassemble around PC (default: 16).',
          default: 16,
        },
        stack_bytes: {
          type: 'number',
          description: 'Bytes to dump from A7 (default: 128).',
          default: 128,
        },
        include_custom: {
          type: 'boolean',
          description: 'Include decoded custom registers in the bundle (default: true).',
          default: true,
        },
        include_chip_window: {
          type: 'boolean',
          description: 'Include a bounded chip RAM window in the bundle (default: false).',
          default: false,
        },
        chip_window_address: {
          type: ['string', 'number'],
          description: 'Optional chip RAM window address if include_chip_window=true.',
        },
        chip_window_bytes: {
          type: 'number',
          description: 'Optional chip RAM window size if include_chip_window=true. Max 16384 bytes.',
          default: 0,
        },
        json_file: {
          type: 'string',
          description: 'Optional absolute host path for JSON output.',
        },
        markdown_file: {
          type: 'string',
          description: 'Optional absolute host path for Markdown output.',
        },
      },
    },
  },

  // Amiga hardware tools
  {
    name: 'winuae_custom_registers',
    description: 'Read all Amiga custom chip registers ($DFF000-$DFF1FE) with names and 16-bit values. Use this to get display/audio/hardware state: BPLCON0 (offset 0x100), BPL1-6 PTH/PTL (0xE0-0xF6: bitplane pointers as 24-bit = PTH low byte << 16 | PTL), AUD0-3 LCH/LCL/LEN/PER/VOL (0xA0-0xDA: Paula), DMACON (0x096), DIWSTRT/STOP, DDFSTRT/STOP (0x8E-0x94), COLOR00-31 (0x180-0x1BE), SPR0-7 PTH/PTL (0x120-0x13E), COP1LCH/L (0x80). From these you can derive bitmap addresses and dimensions, then use winuae_memory_read to dump bitplanes or samples.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_machine_snapshot',
    description: 'Return a structured machine snapshot as JSON text: CPU registers, Amiga custom registers, and optional bounded RAM windows. Memory windows are opt-in and each is capped at 16384 bytes to keep MCP responses manageable.',
    inputSchema: {
      type: 'object',
      properties: {
        include_cpu: {
          type: 'boolean',
          description: 'Include CPU registers in the snapshot (default: true).',
          default: true,
        },
        include_custom: {
          type: 'boolean',
          description: 'Include Amiga custom registers in the snapshot (default: true).',
          default: true,
        },
        chip_ram_address: {
          type: ['string', 'number'],
          description: 'Optional chip RAM window base address (default: $000000 if chip_ram_bytes > 0).',
        },
        chip_ram_bytes: {
          type: 'number',
          description: 'Optional chip RAM bytes to include. 0 disables the window. Max 16384 bytes.',
          default: 0,
        },
        fast_ram_address: {
          type: ['string', 'number'],
          description: 'Optional fast RAM window base address (default: $00200000 if fast_ram_bytes > 0).',
        },
        fast_ram_bytes: {
          type: 'number',
          description: 'Optional fast RAM bytes to include. 0 disables the window. Max 16384 bytes.',
          default: 0,
        },
      },
    },
  },
  {
    name: 'winuae_bitmap_decode',
    description: 'Decode a planar bitmap from Amiga memory to PNG and optional inline RGBA hex. Supports 4/5/6 planes, interleaved or non-interleaved layout, explicit width/height, and palette from arguments or current custom registers.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Base address of the bitmap data in Amiga memory.',
        },
        width: {
          type: 'number',
          description: 'Bitmap width in pixels.',
        },
        height: {
          type: 'number',
          description: 'Bitmap height in pixels.',
        },
        depth: {
          type: 'number',
          description: 'Bitplane depth. MVP supports 4, 5, or 6; implementation accepts 1-6.',
        },
        row_bytes: {
          type: 'number',
          description: 'Bytes per row per bitplane. Default: ceil(width / 16) * 2.',
        },
        layout: {
          type: 'string',
          enum: ['interleaved', 'planar'],
          description: 'Bitplane layout. interleaved=row-by-row per plane, planar=whole plane blocks.',
          default: 'interleaved',
        },
        color_mode: {
          type: 'string',
          enum: ['auto', 'direct', 'ehb'],
          description: 'Palette interpretation. auto chooses EHB for 6-plane decode when palette is derived from custom registers.',
          default: 'auto',
        },
        filepath: {
          type: 'string',
          description: 'Optional full host path for the PNG output.',
        },
        filename: {
          type: 'string',
          description: 'Optional basename for the PNG output in the system temp directory.',
        },
        palette: {
          type: 'array',
          description: 'Optional palette entries as #RRGGBB, #RGB, $RGB, or 0xRGB strings. If omitted, COLOR00-31 from current custom registers is used.',
          items: {
            type: 'string',
          },
        },
        include_rgba_hex: {
          type: 'boolean',
          description: 'Include inline RGBA hex in the response for small images.',
          default: false,
        },
      },
      required: ['address', 'width', 'height', 'depth'],
    },
  },
  {
    name: 'winuae_memory_pattern_search',
    description: 'Search RAM for an exact byte pattern and optionally score repeated matches using a configurable stride. Useful for ILBM/BMHD headers, bitmap row signatures, and repeated structures in memory.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Base address of the RAM range to search.',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to scan. Limited to 262144 bytes.',
        },
        pattern_hex: {
          type: 'string',
          description: 'Exact byte pattern as hex string (spaces allowed).',
        },
        stride_bytes: {
          type: 'number',
          description: 'Optional stride between repeated pattern rows/records.',
        },
        repeat_count: {
          type: 'number',
          description: 'Expected number of repeated matches for stride scoring. Default: 1.',
          default: 1,
        },
        max_results: {
          type: 'number',
          description: 'Maximum candidates to return. Default: 16, capped at 64.',
          default: 16,
        },
      },
      required: ['address', 'length', 'pattern_hex'],
    },
  },
  {
    name: 'winuae_copper_disassemble',
    description: 'Disassemble a Copper list at given address. Decodes WAIT, MOVE, SKIP, END. Use COP1LCH/L from winuae_custom_registers as the address to inspect the current Copper list.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of copper list',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to read (default: 256)',
          default: 256,
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_disassemble_full',
    description: 'Full m68k disassembly at address using WinUAE sm68k disassembler. More accurate than winuae_disassemble.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address (hex with $ or 0x prefix)',
        },
        count: {
          type: 'number',
          description: 'Number of instructions to disassemble (default: 20)',
          default: 20,
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_input_key',
    description: 'Simulate Amiga keyboard: send key press or release by raw scancode (0x00-0x7F). 1=press, 0=release.',
    inputSchema: {
      type: 'object',
      properties: {
        scancode: {
          type: ['string', 'number'],
          description: 'Amiga raw scancode (e.g. 0x45 for Return)',
        },
        state: {
          type: 'number',
          description: '1=press, 0=release (default 1)',
          default: 1,
        },
      },
      required: ['scancode'],
    },
  },
  {
    name: 'winuae_input_event',
    description: 'Send one raw guest input event (monitor `input event`). kind 0 = keyboard (code = Amiga raw keycode < 0x68, value 1/0); kind 1 = mouse axis (port 0/1, code 0=X 1=Y, value = signed delta -127..127); kind 2 = port control (port 0/1, code 0 left 1 right 2 up 3 down 4 fire/left button 5 2nd/right button 6 3rd/middle button, value 1/0). Held keys and controls are released when the debugger detaches.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'number', enum: [0, 1, 2], description: '0 keyboard, 1 mouse axis, 2 port control' },
        port: { type: 'number', description: 'Port 0 or 1 (0 for keyboard)', default: 0 },
        code: { type: ['string', 'number'], description: 'Keycode, axis or control number' },
        value: { type: 'number', description: '1/0 press/release, or a signed mouse delta', default: 1 },
      },
      required: ['kind', 'code'],
    },
  },
  {
    name: 'winuae_input_joy',
    description: 'Simulate joystick/gamepad: port 0 or 1, direction/button (left, right, up, down, fire, 2nd, 3rd), state 1=press 0=release.',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'Joystick port: 0=port 1, 1=port 2',
          default: 0,
        },
        action: {
          type: 'string',
          description: 'Direction or button: left, right, up, down, fire, 2nd, 3rd',
          enum: ['left', 'right', 'up', 'down', 'fire', '2nd', '3rd'],
        },
        state: {
          type: 'number',
          description: '1=press, 0=release (default 1)',
          default: 1,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'winuae_input_mouse',
    description: 'Simulate mouse on port 0 (or `port`): move (dx, dy relative counts; large moves are split into steps of 127), or button (0=left 1=right 2=middle, 1|0 press|release). Absolute positioning is not available in the upstream server.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'move=relative delta, button=button press/release',
          enum: ['move', 'button'],
        },
        dx: { type: 'number', description: 'Delta X for mode=move' },
        dy: { type: 'number', description: 'Delta Y for mode=move' },
        port: { type: 'number', description: 'Mouse port 0 or 1 (default 0)' },
        button: { type: 'number', description: '0=left 1=right 2=middle for mode=button' },
        state: { type: 'number', description: '1=press 0=release for mode=button', default: 1 },
      },
      required: ['mode'],
    },
  },
  {
    name: 'winuae_amiga_input_state',
    description: 'Read the Cursor-Amiga-C automation input buffer (`g_automation_input`) from Amiga memory and decode it as mouse/keyboard/joystick state.',
    inputSchema: {
      type: 'object',
      properties: {
        elf_file: {
          type: 'string',
          description: 'Path to the Amiga ELF used to resolve g_automation_input if automation_address is omitted.',
        },
        automation_address: {
          type: ['string', 'number'],
          description: 'Explicit Amiga memory address of g_automation_input. Overrides elf_file.',
        },
      },
    },
  },
  {
    name: 'winuae_amiga_input_set',
    description: 'Write the Cursor-Amiga-C automation input buffer (`g_automation_input`) so mouse, key and joystick input go directly into the running Amiga app. Supports interpolated mouse movement by screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        elf_file: {
          type: 'string',
          description: 'Path to the Amiga ELF used to resolve g_automation_input if automation_address is omitted.',
        },
        automation_address: {
          type: ['string', 'number'],
          description: 'Explicit Amiga memory address of g_automation_input. Overrides elf_file.',
        },
        preserve_existing: {
          type: 'boolean',
          description: 'Read the current 20-byte buffer and only patch requested fields (default true).',
          default: true,
        },
        enabled: { type: 'boolean' },
        mouse_left: { type: 'boolean' },
        mouse_right: { type: 'boolean' },
        mouse_x: { type: 'number', description: 'Target mouse X in Amiga screen coordinates (0..319).' },
        mouse_y: { type: 'number', description: 'Target mouse Y in Amiga screen coordinates (0..255).' },
        move_steps: {
          type: 'number',
          description: 'If > 1 and mouse_x/y are provided, interpolate cursor movement across this many writes.',
          default: 1,
        },
        move_delay_ms: {
          type: 'number',
          description: 'Delay between interpolated mouse writes (default 0).',
          default: 0,
        },
        joy0_fire: { type: 'boolean' },
        joy0_up: { type: 'boolean' },
        joy0_down: { type: 'boolean' },
        joy0_left: { type: 'boolean' },
        joy0_right: { type: 'boolean' },
        joy1_fire: { type: 'boolean' },
        joy1_up: { type: 'boolean' },
        joy1_down: { type: 'boolean' },
        joy1_left: { type: 'boolean' },
        joy1_right: { type: 'boolean' },
        keycode: {
          type: 'number',
          description: 'Single raw keycode to inject via the automation buffer (0x00..0x7F).',
        },
        clear_key: {
          type: 'boolean',
          description: 'Set the automation key slot back to 0xFF (no key pending).',
          default: false,
        },
      },
    },
  },
  {
    name: 'winuae_amiga_enter_demo',
    description: 'Set `g_automation_enter_demo=1` inside Cursor-Amiga-C so the running app enters demo/effect flow through its software automation path.',
    inputSchema: {
      type: 'object',
      properties: {
        elf_file: {
          type: 'string',
          description: 'Path to the Amiga ELF used to resolve g_automation_enter_demo if enter_demo_address is omitted.',
        },
        enter_demo_address: {
          type: ['string', 'number'],
          description: 'Explicit Amiga memory address of g_automation_enter_demo. Overrides elf_file.',
        },
      },
    },
  },
  {
    name: 'winuae_run_program',
    description: 'Load an Amiga executable into memory, set PC to entry, and start execution.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to Amiga executable on host',
        },
        entry: {
          type: ['string', 'number'],
          description: 'Entry address (default: 0x40000)',
          default: '0x40000',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'winuae_findproc',
    description: 'List Exec tasks and processes (monitor `tasks`). With name, return the matching task(s) and, for processes, their LoadSeg segments (the runtime bases for symbol relocation). Matching is case-insensitive on the task name or the CLI command\'s file part.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task or command name to look for (e.g. "vd" or "a.exe"). Omit to list all tasks.' },
      },
      required: [],
    },
  },
  {
    name: 'winuae_process_break',
    description: 'Arm a one-shot breakpoint on a process\'s entry point (monitor `process-break`): the CPU stops at the first instruction of the next AmigaDOS program with that name (or Process address) once it is loaded. Stop reply carries winuae-entry. action=status/clear manage it. Continue the CPU and use winuae_wait_stop to catch it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['name', 'address', 'status', 'clear'], description: 'name/address arm it; status/clear (default status)' },
        value: { type: ['string', 'number'], description: 'Program name for action=name, Process address for action=address' },
      },
    },
  },
  {
    name: 'winuae_monitor',
    description: 'Send any monitor command to WinUAE\'s GDB server and return its decoded reply (usually JSON). `capabilities` lists what this build supports, including the display resolution. Numbers in arguments are hex. Useful: tasks, exception, exception-mask <hex>, guest-output on|read|clear, checkpoint save|restore <path>, condition add|list|remove, dma-watch add|list|remove, input status|release, floppy status, memory-check <addr> <len>.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Monitor command line, e.g. "capabilities" or "floppy status"' },
        timeout_ms: { type: 'number', description: 'Reply timeout (default 15000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'winuae_disassemble',
    description: 'Read memory and show as raw 68k words. Note: basic decode only — use winuae_disassemble_full for full disassembly.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address',
        },
        count: {
          type: 'number',
          description: 'Number of words to show (default: 20)',
          default: 20,
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_screenshot',
    description: 'Capture the Amiga display to PNG and return it inline. Uses WinUAE\'s own framebuffer grab (monitor `screenshot`), the clean emulated picture, scaled to display aspect unless aspect=false. The CPU is halted for the grab and resumed if it was running. Does NOT fall back: if the internal grab fails it says so, and you retry with capture_mode: \'host_window\' (a desktop-region grab of the WinUAE window, subject to DPI scaling and occlusion).',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: {
          type: 'string',
          description: 'Full host path for the PNG (preferred).',
        },
        filename: {
          type: 'string',
          description: 'Basename only; combined with system temp dir if not absolute.',
        },
        capture_mode: {
          type: 'string',
          enum: ['internal', 'monitor', 'auto', 'host_window'],
          description: "internal (default; monitor and auto are aliases)=WinUAE's own framebuffer grab, no fallback. host_window=grab the visible WinUAE window off the desktop; only use this after an internal capture has failed.",
          default: 'internal',
        },
        alpha: {
          type: 'boolean',
          description: 'Internal capture only. Keep the genlock key as a PNG alpha channel instead of making the image opaque; keyed (video) areas become transparent. Only meaningful when genlock_alpha is set, and off by default since a transparent PNG is harder to read.',
          default: false,
        },
        aspect: {
          type: 'boolean',
          description: 'Internal capture only. Scale the raw frame buffer horizontally to the displayed aspect (by 2^(vresolution - resolution) from `capabilities`). Default true; false returns the raw buffer.',
          default: true,
        },
        inline: {
          type: 'boolean',
          description: 'Return the PNG directly as an inline image in the tool result (default true). Set false to get only the file path/metadata.',
          default: true,
        },
      },
    },
  },
  {
    name: 'winuae_exec_chunk',
    description: 'Write raw 680x0 machine code to Amiga memory, set PC (and optionally A7), optionally resume CPU. CPU is paused first. Use for tiny test stubs; you must supply valid code (e.g. ending in RTS) and a valid stack if you continue. GDB register indices: PC=17, A7=15.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address to write bytes (hex with $ or 0x)',
        },
        hex: {
          type: 'string',
          description: 'Hex-encoded bytes (no spaces), even length. Example: 4e754e71 for RTS;NOP',
        },
        pc: {
          type: ['string', 'number'],
          description: 'PC after write (default: same as address)',
        },
        sp: {
          type: ['string', 'number'],
          description: 'Optional A7/stack pointer before continue',
        },
        continue_after: {
          type: 'boolean',
          description: 'If true (default), call continue after patching. If false, leave CPU paused.',
          default: true,
        },
      },
      required: ['address', 'hex'],
    },
  },
];

// ─── Tool Implementations ────────────────────────────────────────────

async function handleToolCall(name: string, args: any): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }> {
  try {
    const normalizedArgs = (args ?? {}) as Record<string, unknown>;

    await tryAutoAttachForTool(name, normalizedArgs);

    if (connection?.connected && !CONNECTION_OPTIONAL_TOOLS.has(name)) {
      connection.markActivity(name);
    }

    switch (name) {
      case 'winuae_connect': {
        if (connection?.connected) {
          connection.markActivity('connect_reuse');
          return { content: [{ type: 'text', text: JSON.stringify({
            message: 'Already connected to WinUAE',
            session: connection.getSessionInfo(),
          }, null, 2) }] };
        }
        const cfg: WinUAEConfig = getBaseConfigForArgs(normalizedArgs);
        const previousConnection = connection;
        connection = new WinUAEConnection(cfg);
        if (previousConnection) {
          cloneConnectionState(previousConnection, connection);
        }
        const connectBehavior = getConnectBehavior(normalizedArgs);
        if (args?.idle_timeout_ms !== undefined || args?.idle_action !== undefined) {
          connection.setSessionIdlePolicy(
            Number(args?.idle_timeout_ms ?? 0),
            args?.idle_action as SessionIdleAction | undefined
          );
        }
        const statusMsg = await connection.connectSmart(connectBehavior);
        return { content: [{ type: 'text', text: JSON.stringify({
          message: statusMsg,
          connect_behavior: connectBehavior,
          session: connection.getSessionInfo(),
        }, null, 2) }] };
      }

      case 'winuae_connect_existing': {
        if (connection?.connected) {
          connection.markActivity('connect_existing_reuse');
          return { content: [{ type: 'text', text: JSON.stringify({
            message: 'Already connected to WinUAE',
            session: connection.getSessionInfo(),
          }, null, 2) }] };
        }
        const cfgEx: WinUAEConfig = getBaseConfigForArgs(normalizedArgs);
        const previousConnection = connection;
        connection = new WinUAEConnection(cfgEx);
        if (previousConnection) {
          cloneConnectionState(previousConnection, connection);
        }
        const connectBehavior = getConnectBehavior(normalizedArgs);
        if (args?.idle_timeout_ms !== undefined || args?.idle_action !== undefined) {
          connection.setSessionIdlePolicy(
            Number(args?.idle_timeout_ms ?? 0),
            args?.idle_action as SessionIdleAction | undefined
          );
        }
        await connection.connectExisting(connectBehavior);
        return { content: [{ type: 'text', text: JSON.stringify({
          message: `Connected to existing WinUAE GDB server on port ${config.gdbPort}. Do not call winuae_load (program already running).`,
          connect_behavior: connectBehavior,
          session: connection.getSessionInfo(),
        }, null, 2) }] };
      }

      case 'winuae_disconnect': {
        if (!connection) {
          return { content: [{ type: 'text', text: 'Not connected to WinUAE' }] };
        }
        const stopEmulator = args?.stop_emulator !== false;
        await connection.disconnect(stopEmulator);
        connection = null;
        return { content: [{ type: 'text', text: stopEmulator ? 'Disconnected from WinUAE and stopped the emulator process' : 'Disconnected from WinUAE but left the emulator process running' }] };
      }

      case 'winuae_status': {
        if (!connection) {
          return { content: [{ type: 'text', text: JSON.stringify({
            connected: false,
            trackedProcessRunning: false,
            message: 'No MCP WinUAE session has been created in this server process yet.',
          }, null, 2) }] };
        }
        const healthy = await connection.healthCheck();
        return { content: [{ type: 'text', text: JSON.stringify({
          ...connection.getSessionInfo(),
          healthy,
          floppies: Object.fromEntries(connection.getFloppies()),
          emulatorVisible: process.env.WINUAE_HEADLESS !== '1',
        }, null, 2) }] };
      }

      case 'winuae_session_config': {
        if (!connection) {
          connection = new WinUAEConnection(config);
        }
        const current = connection.getSessionInfo();
        connection.setSessionIdlePolicy(
          Math.max(0, Number(args?.idle_timeout_ms ?? current.idleTimeoutMs)),
          (args?.idle_action as SessionIdleAction | undefined) ?? current.idleAction
        );
        return { content: [{ type: 'text', text: JSON.stringify({
          message: 'WinUAE session policy updated',
          session: connection.getSessionInfo(),
        }, null, 2) }] };
      }

      case 'winuae_memory_map': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const reply = await protocol.sendMonitorJson('memory-map', 10000);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              addressing: reply?.addressing,
              truncated: reply?.truncated === true,
              banks: parseMonitorMemoryMap(reply),
            }, null, 2),
          }],
        };
      }

      case 'winuae_qoffsets': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const procAddr = args?.process !== undefined ? parseHexOrDecimal(args.process) : undefined;
        const info = await readSegments(protocol, procAddr);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              text: info.segments[0]?.address ?? null,
              text_hex: info.segments[0] ? hex32(info.segments[0].address) : null,
              process: hex32(info.process),
              name: info.name,
              command: info.command,
              segments: info.segments.map((g) => ({ index: g.index, address: hex32(g.address), size: g.size })),
            }, null, 2),
          }],
        };
      }

      case 'winuae_load': {
        const { file } = args;
        const { readFileSync, existsSync } = await import('fs');
        const { resolve } = await import('path');

        const absPath = resolve(file);
        if (!existsSync(absPath)) {
          throw new Error(`File not found: ${absPath}`);
        }

        // Detect disk images by extension — delegate to disk insertion
        if (isDiskImage(absPath)) {
          if (!connection) {
            connection = new WinUAEConnection(config);
          }
          connection.setFloppy(0, absPath);
          if (connection.connected) {
            const statusMsg = await connection.restart();
            return { content: [{ type: 'text', text: `Detected disk image. Inserted ${absPath} into DF0: and restarted.\n${statusMsg}` }] };
          } else {
            return { content: [{ type: 'text', text: `Detected disk image. ${absPath} set for DF0:. Call winuae_connect to boot.` }] };
          }
        }

        // Load binary into memory via GDB (chunked writes)
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const fileData = readFileSync(absPath);
        const protocol = connection.getProtocol();

        try {
          await protocol.pause();
        } catch {
          // Some sessions are already paused after connect; ignore and proceed.
        }

        const loadAddr = args.address !== undefined
          ? parseHexOrDecimal(args.address)
          : 0x4000;

        if (isAmigaHunkExecutable(fileData)) {
          const program = loadAmigaHunk(fileData, loadAddr);
          console.error(`[WinUAE] Detected AmigaHunk executable: ${absPath}`);
          for (const hunk of program.hunks) {
            console.error(`[WinUAE] Loading hunk ${hunk.type} ${hunk.data.length} bytes to ${hex32(hunk.baseAddress)}...`);
            await protocol.writeMemory(hunk.baseAddress, hunk.data);
          }

          const verifyLen = Math.min(16, program.hunks[0].data.length);
          const readBack = await protocol.readMemory(program.hunks[0].baseAddress, verifyLen);
          const match = readBack.equals(program.hunks[0].data.subarray(0, verifyLen));
          const verifyMsg = match
            ? 'Verify OK (first relocated bytes match)'
            : `VERIFY MISMATCH! Expected: ${program.hunks[0].data.subarray(0, verifyLen).toString('hex')} Got: ${readBack.toString('hex')}`;

          const hunkSummary = program.hunks
            .map((hunk, index) => `Hunk ${index}: ${hunk.type} ${hex32(hunk.baseAddress)} (${hunk.sizeBytes} bytes)`)
            .join('\n');
          return {
            content: [{
              type: 'text',
              text: `Loaded relocatable AmigaHunk program from ${absPath}\nEntry=${hex32(program.entryAddress)} Total=${program.totalBytes} bytes\n${hunkSummary}\n${verifyMsg}`,
            }],
          };
        }

        console.error(`[WinUAE] Loading ${fileData.length} bytes to ${hex32(loadAddr)} (chunked)...`);
        await protocol.writeMemory(loadAddr, fileData);

        // Verify first 16 bytes to confirm write succeeded
        const verifyLen = Math.min(16, fileData.length);
        const readBack = await protocol.readMemory(loadAddr, verifyLen);
        const match = readBack.equals(fileData.subarray(0, verifyLen));
        const verifyMsg = match
          ? 'Verify OK (first 16 bytes match)'
          : `VERIFY MISMATCH! Expected: ${fileData.subarray(0, verifyLen).toString('hex')} Got: ${readBack.toString('hex')}`;

        return { content: [{ type: 'text', text: `Loaded ${fileData.length} bytes from ${absPath} at ${hex32(loadAddr)}\n${verifyMsg}` }] };
      }

      case 'winuae_reset': {
        if (!connection) throw new Error('Not connected to WinUAE');
        // Restart WinUAE entirely — this is a hard reset (power cycle)
        const statusMsg = await connection.restart();
        // After restart, pause and read registers
        const resetProtocol = connection.getProtocol();
        try {
          await resetProtocol.pause();
        } catch {
          // May already be paused after fresh connect
        }
        const regs = await resetProtocol.readRegisters();
        return { content: [{ type: 'text', text: `Reset complete. ${statusMsg}\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_warp': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const mode = String(args.mode || 'status');
        const arg = mode === '1' || mode === 'on' ? ' on' : mode === '0' || mode === 'off' ? ' off' : '';
        const result = await protocol.sendMonitorJson(`warp${arg}`, 5000);
        const on = result?.warp === true;
        return { content: [{ type: 'text', text: on ? 'Warp mode is ENABLED (turbo speed)' : 'Warp mode is DISABLED (normal speed)' }] };
      }

      case 'winuae_insert_disk': {
        const { file, drive = 0 } = args;
        const { existsSync } = await import('fs');
        const { resolve } = await import('path');

        const absPath = resolve(file);
        if (!existsSync(absPath)) {
          throw new Error(`File not found: ${absPath}`);
        }

        if (!connection) {
          connection = new WinUAEConnection(config);
        }

        connection.setFloppy(drive, absPath);

        if (connection.connected) {
          const protocol = connection.getProtocol();
          try {
            // No quotes: the path runs to the end of the line, spaces and all.
            await protocol.sendMonitorCommand(`floppy insert ${drive} ${absPath}`, 15000);
            return { content: [{ type: 'text', text: `Inserted ${absPath} into DF${drive}: (hot-swap, no restart).` }] };
          } catch {
            if (!connection.canAutoRestartManagedProcess()) {
              const session = connection.getSessionInfo();
              return {
                content: [{
                  type: 'text',
                  text:
                    `Hot-swap insert for DF${drive}: failed in the current attached session, and MCP did not restart it because this emulator was not launched by the current MCP connection.\n` +
                    `Requested disk remains tracked for the next managed launch: ${absPath}\n` +
                    `Session mode=${session.connectionMode} trackedProcessRunning=${session.trackedProcessRunning}`,
                }],
              };
            }
            const statusMsg = await connection.restart();
            return { content: [{ type: 'text', text: `Inserted ${absPath} into DF${drive}: and restarted.\n${statusMsg}` }] };
          }
        } else {
          return { content: [{ type: 'text', text: `Disk ${absPath} set for DF${drive}:. Will be mounted on next winuae_connect.` }] };
        }
      }

      case 'winuae_eject_disk': {
        const { drive = 0 } = args;

        if (!connection) {
          return { content: [{ type: 'text', text: 'No connection. Nothing to eject.' }] };
        }

        connection.setFloppy(drive, null);

        if (connection.connected) {
          const protocol = connection.getProtocol();
          try {
            await protocol.sendMonitorCommand(`floppy eject ${drive}`, 5000);
            return { content: [{ type: 'text', text: `Ejected DF${drive}: (hot-swap, no restart).` }] };
          } catch {
            if (!connection.canAutoRestartManagedProcess()) {
              const session = connection.getSessionInfo();
              return {
                content: [{
                  type: 'text',
                  text:
                    `Hot-swap eject for DF${drive}: failed in the current attached session, and MCP did not restart it because this emulator was not launched by the current MCP connection.\n` +
                    `Requested eject remains tracked for the next managed launch.\n` +
                    `Session mode=${session.connectionMode} trackedProcessRunning=${session.trackedProcessRunning}`,
                }],
              };
            }
            const statusMsg = await connection.restart();
            return { content: [{ type: 'text', text: `Ejected DF${drive}: and restarted.\n${statusMsg}` }] };
          }
        } else {
          return { content: [{ type: 'text', text: `DF${drive}: cleared. Will take effect on next winuae_connect.` }] };
        }
      }

      case 'winuae_profile_ollama': {
        const os = await import('os');
        const req: ProfileOllamaRequest = {
          numFrames: Math.max(1, Math.min(100, args.num_frames ?? 4)),
          outDir: args.out_dir ? path.resolve(String(args.out_dir)) : path.join(os.tmpdir(), `winuae-profile-ollama-${Date.now()}`),
          sidePort: Number(args.side_port ?? 2346),
          lockOwner: 'mcp-profile-ollama',
          waitCmd: args.wait_cmd ? String(args.wait_cmd) : undefined,
          waitContains: args.wait_contains ? String(args.wait_contains) : undefined,
          waitTimeoutMs: 20000,
          prompt: args.prompt ? String(args.prompt) : undefined,
          promptFile: args.prompt_file ? path.resolve(String(args.prompt_file)) : undefined,
          model: args.model ? String(args.model) : '',
          textModel: args.text_model ? String(args.text_model) : '',
          base: args.base ? String(args.base) : '',
          mode: (['meta', 'frames', 'montage', 'all'] as const).includes(args.mode) ? args.mode : 'all',
          selectedFrames: args.frames
            ? String(args.frames).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
            : undefined,
        };
        const report = await analyzeProfile(req);
        return { content: [{ type: 'text', text: report }] };
      }

      case 'winuae_memory_read': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length } = args;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        return { content: [{ type: 'text', text: `Memory ${hex32(addr)}-${hex32(addr + length - 1)}:\n${hexStr}` }] };
      }

      case 'winuae_memory_write': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const bytes = Buffer.from(args.data.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
        const protocol = connection.getProtocol();
        // The M handler writes straight through the addrbank, so it does not
        // need a halted CPU. Pausing by default was expensive (it stalls WinUAE's
        // Win32 message pump while the stub sits in its halt loop) and left the
        // emulator stopped without the caller asking. Set WINUAE_MEMORY_WRITE_PAUSE=1
        // to restore the old halt-first behaviour when a write must be atomic
        // with respect to the running program.
        let paused = false;
        if (process.env.WINUAE_MEMORY_WRITE_PAUSE === '1') {
          try {
            await protocol.pause();
            paused = true;
          } catch {
            // Already paused, or pause failed; write anyway
          }
        }
        await protocol.writeMemory(addr, bytes);
        const note = paused
          ? ' CPU is paused; use winuae_continue to resume.'
          : ' CPU left running. To hold a value against the running program, use winuae_protect with action=set.';
        return { content: [{ type: 'text', text: `Wrote ${bytes.length} bytes to ${hex32(addr)}.${note}` }] };
      }

      case 'winuae_memory_dump': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, bytesPerLine = 16 } = args;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const dump = hexDump(data, addr, bytesPerLine);
        return { content: [{ type: 'text', text: dump }] };
      }

      case 'winuae_registers_get': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: formatRegisters(regs) }] };
      }

      case 'winuae_registers_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();

        // Register name to GDB index mapping
        const REG_INDEX: Record<string, number> = {
          D0: 0, D1: 1, D2: 2, D3: 3, D4: 4, D5: 5, D6: 6, D7: 7,
          A0: 8, A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15,
          SR: 16, PC: 17,
        };

        const toWrite: Array<{ name: string; idx: number; value: number }> = [];
        for (const [regName, rawValue] of Object.entries(args)) {
          if (rawValue === undefined || rawValue === null) continue;
          const idx = REG_INDEX[regName];
          if (idx === undefined) continue;
          toWrite.push({ name: regName, idx, value: parseHexOrDecimal(rawValue as string | number) });
        }

        if (toWrite.length === 0) {
          return { content: [{ type: 'text', text: 'No registers specified to write' }] };
        }

        const results: string[] = [];
        const needsCoherentWrite = toWrite.some(({ name }) => name === 'PC' || name === 'SR' || name === 'A7');

        if (needsCoherentWrite) {
          const regs = await protocol.readRegisters();
          for (const { name, value } of toWrite) {
            (regs as unknown as Record<string, number>)[name] = value >>> 0;
          }
          await protocol.writeRegisters(regs);
          const actualRegs = await protocol.readRegisters();
          for (const { name, value } of toWrite) {
            const actual = ((actualRegs as unknown as Record<string, number>)[name] ?? 0) >>> 0;
            if (actual !== (value >>> 0)) {
              results.push(`${name}=${hex32(value)} (VERIFY FAILED: got ${hex32(actual)})`);
            } else {
              results.push(`${name}=${hex32(value)}`);
            }
          }
        } else {
          // Keep single-register writes for low-risk edits that do not change execution context.
          for (const { name, idx, value } of toWrite) {
            await protocol.writeRegister(idx, value);
            const actual = await protocol.readRegister(idx);
            if (actual !== (value >>> 0)) {
              results.push(`${name}=${hex32(value)} (VERIFY FAILED: got ${hex32(actual)})`);
            } else {
              results.push(`${name}=${hex32(value)}`);
            }
          }
        }

        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Set ${results.join(', ')}\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_breakpoint_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const protocol = connection.getProtocol();
        await protocol.setBreakpoint(addr);
        return { content: [{ type: 'text', text: `Breakpoint set at ${hex32(addr)}` }] };
      }

      case 'winuae_breakpoint_clear': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const protocol = connection.getProtocol();
        await protocol.clearBreakpoint(addr);
        return { content: [{ type: 'text', text: `Breakpoint cleared at ${hex32(addr)}` }] };
      }

      case 'winuae_breakpoint_conditional_wait': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const request = normalizeConditionalBreakpointRequest(args as Record<string, unknown>, CUSTOM_REGS);
        let hits = 0;
        let breakpointCleared = false;
        const startedAt = Date.now();
        let responsePayload: Record<string, unknown> | null = null;

        await protocol.setBreakpoint(request.address);

        try {
          while (hits < request.maxHits) {
            const remaining = request.timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) {
              responsePayload = buildConditionalBreakpointResponse({
                request,
                hits,
                matched: false,
                timedOut: true,
                breakpointCleared,
              });
              break;
            }

            await protocol.continue();
            const stopReply = await protocol.waitForStop(remaining);
            const registers = await protocol.readRegisters();
            hits += 1;

            let customData: Buffer | undefined;
            if (request.customEquals.length > 0) {
              customData = (await readCustomRegisterData(protocol)).data;
            }

            let memoryByAddress: Map<number, Buffer> | undefined;
            if (request.memoryEquals.length > 0) {
              memoryByAddress = new Map<number, Buffer>();
              for (const condition of request.memoryEquals) {
                memoryByAddress.set(
                  condition.address,
                  await protocol.readMemory(condition.address, condition.value.length)
                );
              }
            }

            const evaluation = evaluateConditionalBreakpoint(request, {
              registers,
              customData,
              memoryByAddress,
            });

            if (evaluation.matched) {
              responsePayload = buildConditionalBreakpointResponse({
                request,
                hits,
                matched: true,
                stopReply,
                breakpointCleared,
                registers,
                evaluation,
              });
              break;
            }
          }

          if (!responsePayload) {
            const registers = await protocol.readRegisters();
            responsePayload = buildConditionalBreakpointResponse({
              request,
              hits,
              matched: false,
              breakpointCleared,
              registers,
            });
          }
        } finally {
          if (request.autoClear) {
            try {
              await protocol.clearBreakpoint(request.address);
              breakpointCleared = true;
            } catch {
              breakpointCleared = false;
            }
          }
        }

        if (responsePayload) {
          (responsePayload.breakpoint as { address: string; auto_cleared: boolean }).auto_cleared = breakpointCleared;
        }

        return { content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }] };
      }

      case 'winuae_watchpoint_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, type } = args;
        const protocol = connection.getProtocol();
        await protocol.setWatchpoint(addr, length, type as WatchpointType);
        return { content: [{ type: 'text', text: `Watchpoint (${type}) set at ${hex32(addr)}, ${length} bytes` }] };
      }

      case 'winuae_watchpoint_clear': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, type } = args;
        const protocol = connection.getProtocol();
        await protocol.clearWatchpoint(addr, length, type as WatchpointType);
        return { content: [{ type: 'text', text: `Watchpoint (${type}) cleared at ${hex32(addr)}` }] };
      }

      // ── WinUAE-DBG v2.1 monitor extensions (e9k-style) ────────────────
      case 'winuae_emulator_status': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const status = await protocol.sendMonitorJson('execution-status', 10000);
        const warp = await protocol.sendMonitorJson('warp', 5000);
        const caps = await protocol.sendMonitorJson('capabilities', 5000);
        return { content: [{ type: 'text', text: JSON.stringify({
          ...status,
          warp: warp?.warp === true,
          display: caps?.display,
          cpu_model: caps?.cpu_model,
        }, null, 2) }] };
      }

      case 'winuae_watchpoint_set_ext': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const addr = parseHexOrDecimal(args.address);
        const accessName = String(args.access ?? 'rw');
        const accessBits: Record<string, number> = { r: 1, w: 2, rw: 3, x: 4 };
        const access = accessBits[accessName];
        if (!access) throw new Error(`Unknown access: ${accessName}`);
        const sourceName = String(args.source ?? 'all');
        let sources = WATCH_SOURCE_MASKS[sourceName];
        if (sources === undefined) throw new Error(`Unknown source: ${sourceName}`);
        const range = args.length !== undefined || access === 4;
        if (access === 4) sources = 1; // instruction fetch needs the CPU fetch source, and only it
        const valueOn = args.value !== undefined ? 1 : 0;
        const value = valueOn ? parseHexOrDecimal(args.value) : 0;
        const mask = args.mask !== undefined ? parseHexOrDecimal(args.mask) : 0xffffffff;
        const change = args.must_change ? 1 : 0;
        if (change && range) throw new Error('must_change needs an exact watch (size, not length) with write access');
        const logOnly = args.nobreak ? 1 : 0;
        const width = range ? Number(args.length ?? 2) : Number(args.size ?? 32) / 8;
        const verb = range ? 'watch range' : 'watch add';
        const cmd = `${verb} ${[addr, width, access, sources, valueOn, value, mask, change, logOnly].map(mhex).join(' ')}`;
        const reply = await protocol.sendMonitorJson(cmd, 10000);
        return { content: [{ type: 'text', text: JSON.stringify({ id: reply?.id, command: cmd }, null, 2) }] };
      }

      case 'winuae_watchpoint_last': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const cmd = args?.clear ? 'watch clear-events' : args?.all ? 'watch events' : 'watch last';
        const text = await protocol.sendMonitorCommand(cmd, 10000);
        return { content: [{ type: 'text', text: text.trim() }] };
      }

      case 'winuae_watchpoint_list': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const text = await protocol.sendMonitorCommand('watch list', 10000);
        return { content: [{ type: 'text', text: text.trim() }] };
      }

      case 'winuae_watchpoint_clear_ext': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        let ids: number[];
        if (args.all || args.idx === undefined) {
          const list = await protocol.sendMonitorJson<any[]>('watch list', 10000);
          ids = (list ?? []).map((w) => Number(w.id));
        } else {
          ids = [Number(args.idx)];
        }
        for (const id of ids) await protocol.sendMonitorCommand(`watch remove ${mhex(id)}`, 10000);
        return { content: [{ type: 'text', text: `Removed ${ids.length} watchpoint(s)${ids.length ? `: ${ids.join(', ')}` : ''}` }] };
      }

      case 'winuae_trace': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const action = String(args.action ?? 'read');
        if (action === 'on' || action === 'off') {
          await protocol.sendMonitorCommand(`history ${action}`, 10000);
          return { content: [{ type: 'text', text: `Instruction history recording ${action}` }] };
        }
        const count = Math.max(1, Math.min(128, Number(args.count ?? 32)));
        const reply = await protocol.sendMonitorJson(`history read ${mhex(count)}`, 10000);
        const names = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
        const entries = (reply?.entries ?? []).map((e: any) => ({
          pc: hex32(e.pc), frame: e.frame, vpos: e.vpos, hpos: e.hpos,
          regs: Object.fromEntries((e.registers ?? []).map((v: number, i: number) => [names[i], hex32(v)])),
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ recording: reply?.recording, truncated: reply?.truncated, entries }, null, 2) }] };
      }

      case 'winuae_base': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const procAddr = args?.process !== undefined ? parseHexOrDecimal(args.process) : undefined;
        const info = await readSegments(protocol, procAddr);
        const lines = [`process=${hex32(info.process)} name=${info.name}${info.command ? ` command=${info.command}` : ''}`];
        for (const g of info.segments) lines.push(`sec${g.index}=0x${g.address.toString(16).padStart(8, '0')} size=${g.size}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'winuae_print': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        let expr = String(args.expr ?? '').trim();
        const size = Number(args.size ?? 32);
        const mapPath = args.mapPath ? String(args.mapPath) : '';
        let deref = expr.startsWith('*');
        if (deref) expr = expr.slice(1).trim();
        const isAddr = /^0x[0-9a-fA-F]+$/.test(expr);
        if (!isAddr) {
          if (!mapPath || !fs.existsSync(mapPath)) {
            throw new Error(`Symbol "${expr}" requires mapPath (path to the demo .map)`);
          }
          // parsear simbolo base + camino (.member / [N])
          const pathParts: { kind: 'member' | 'index'; value: string | number }[] = [];
          let base = expr;
          const mm = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(expr);
          if (mm) {
            base = mm[1];
            let rest = mm[2];
            while (rest.length) {
              const mbr = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
              const idx = /^\[(\d+)\]/.exec(rest);
              if (mbr) { pathParts.push({ kind: 'member', value: mbr[1] }); rest = rest.slice(mbr[0].length); }
              else if (idx) { pathParts.push({ kind: 'index', value: parseInt(idx[1], 10) }); rest = rest.slice(idx[0].length); }
              else break;
            }
          }
          // resolver la base (linked -> runtime) via .map + secciones
          const runtimeSections: number[] = [];
          for (const g of (await readSegments(protocol)).segments) runtimeSections[g.index] = g.address;
          const mapSections: { name: string; start: number; size: number }[] = [];
          for (const raw of fs.readFileSync(mapPath, 'utf8').split(/\r?\n/g)) {
            const m = /^\.(text|rodata|data|bss)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)/.exec(raw);
            if (!m) continue;
            const size2 = parseInt(m[3], 16);
            if (size2 === 0) continue;
            mapSections.push({ name: m[1], start: parseInt(m[2], 16), size: size2 });
          }
          // linked address: preferir DW_AT_location del DIE (DW_OP_addr) sobre el .map
          let linked = -1;
          let variableDie: any = null;
          if (pathParts.length || true) {
            const elfPath = mapPath.replace(/\.map$/, '.elf');
            if (fs.existsSync(elfPath)) {
              const { DwarfReader } = await import('./dwarf.js');
              const dr2 = new DwarfReader(elfPath);
              dr2.parse();
              variableDie = dr2.findVariable(base);
              if (variableDie) { const la = dr2.variableAddress(variableDie); if (la !== null) linked = la; }
            }
          }
          if (linked < 0) {
            // fallback: secciones por-objeto del .map (.data._ZN...NnL6g_gameE -> g_game)
            const demangleVar = (mangled: string): string | null => {
              const m = /(?:.*)(\d+)([A-Za-z_][A-Za-z0-9_]*?)E?$/.exec(mangled);
              if (!m) return null;
              const len = parseInt(m[1], 10);
              return m[2].slice(0, len) || null;
            };
            const mapLines = fs.readFileSync(mapPath, 'utf8').split(/\r?\n/g);
            for (let i = 0; i < mapLines.length; i++) {
              const sec = /^\s+\.(?:data|text|rodata|bss)\.(\S+)\s*$/.exec(mapLines[i]);
              if (!sec) continue;
              const addrLine = /^\s*0x([0-9a-fA-F]+)\s+0x/.exec(mapLines[i + 1] ?? '');
              if (!addrLine) continue;
              const varName = demangleVar(sec[1]);
              if (varName === base) { linked = parseInt(addrLine[1], 16); break; }
            }
          }
          if (linked < 0) {
            for (const raw of fs.readFileSync(mapPath, 'utf8').split(/\r?\n/g)) {
              const m = new RegExp(`^\\s*0x([0-9a-fA-F]+)\\s+${base}\\b`).exec(raw);
              if (m) { linked = parseInt(m[1], 16); break; }
            }
          }
          if (linked < 0) throw new Error(`Symbol "${base}" no resuelto (ni DWARF ni .map)`);
          const idx = mapSections.findIndex(s => linked >= s.start && linked < s.start + s.size);
          const runtimeBase = (idx >= 0 && runtimeSections[idx]) ? runtimeSections[idx] : (runtimeSections[0] ?? 0);
          if (!runtimeBase) throw new Error('Section base is 0; set it with winuae_base or query after the demo loads');
          const secStart = idx >= 0 ? mapSections[idx].start : 0x400;
          let addr = runtimeBase + (linked - secStart);

          // caminar miembros/index con DWARF si hay path
          if (pathParts.length) {
            const elfPath = mapPath.replace(/\.map$/, '.elf');
            if (!fs.existsSync(elfPath)) throw new Error(`No .elf para resolver miembros: ${elfPath}`);
            const { DwarfReader } = await import('./dwarf.js');
            const dr = new DwarfReader(elfPath);
            dr.parse();
            let typeDie = variableDie ? (() => { const t = variableDie.attrs.get(0x49); return t ? dr.resolveRef(t.value) : null; })() : null;
            for (const part of pathParts) {
              const rt = dr.resolveType(typeDie);
              if (part.kind === 'member') {
                const m = rt.members.find(x => x.name === part.value);
                if (!m) throw new Error(`Campo "${part.value}" no existe`);
                addr += m.offset;
                typeDie = m.typeDie;
              } else {
                // [N]: array; si el tipo no se resuelve como array, usamos el
                // tamano del elemento (si lo sabemos) o 2 (u16 por defecto)
                if (rt.kind === 'array' && rt.elementSize) {
                  addr += (part.value as number) * rt.elementSize;
                } else if (rt.kind === 'array' && rt.arrayCount && rt.size) {
                  addr += (part.value as number) * Math.max(1, Math.floor(rt.size / rt.arrayCount));
                } else if (rt.kind === 'struct' && rt.size) {
                  addr += (part.value as number) * rt.size;
                } else {
                  addr += (part.value as number) * 2;
                }
                typeDie = rt.die ?? typeDie;
              }
            }
            const finalType = dr.resolveType(typeDie);
            const effSize = finalType.size && finalType.size <= 4 ? finalType.size : 4;
            expr = `0x${addr.toString(16)} size=${finalType.size === 1 ? 8 : finalType.size === 2 ? 16 : effSize * 8}`;
          } else {
            expr = `0x${addr.toString(16)}`;
          }
        }
        // The upstream server has no `print`; read the memory here.
        const sizeMatch = /size=(8|16|32)/.exec(expr);
        const bits = sizeMatch ? Number(sizeMatch[1]) : size;
        const bytes = bits / 8;
        let at = parseInt(expr.split(' ')[0], 16) >>> 0;
        let pointer: number | undefined;
        if (deref) {
          pointer = (await protocol.readMemory(at, 4)).readUInt32BE(0);
          at = pointer;
        }
        const data = await protocol.readMemory(at, bytes);
        const value = bytes === 1 ? data.readUInt8(0) : bytes === 2 ? data.readUInt16BE(0) : data.readUInt32BE(0);
        const signed = bytes === 1 ? data.readInt8(0) : bytes === 2 ? data.readInt16BE(0) : data.readInt32BE(0);
        const hexValue = '0x' + value.toString(16).padStart(bytes * 2, '0');
        return { content: [{ type: 'text', text: `${pointer !== undefined ? `*${hex32(parseInt(expr.split(' ')[0], 16))} -> ` : ''}${hex32(at)} (${bits}-bit) = ${hexValue} (${value}, signed ${signed})` }] };
      }

      case 'winuae_step': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { count = 1 } = args;
        const protocol = connection.getProtocol();

        for (let i = 0; i < count; i++) {
          await protocol.step();
        }

        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Stepped ${count} instruction(s)\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_continue': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        await protocol.continue();
        return { content: [{ type: 'text', text: 'Execution resumed. Call winuae_wait_stop to wait for next breakpoint (or winuae_pause to interrupt).' }] };
      }

      case 'winuae_wait_stop': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const timeoutMs = args.timeout_ms ?? 30000;
        const stopReply = await protocol.waitForStop(timeoutMs);
        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Stopped (${stopReply})\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_pause': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const stopReply = await protocol.pause();
        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Paused (${stopReply})\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_postmortem_capture': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const report = await buildPostmortemReport({
          protocol,
          customRegs: CUSTOM_REGS,
        }, {
          stopReply: args.stop_reply ? String(args.stop_reply) : undefined,
          stackBytes: args.stack_bytes !== undefined ? Number(args.stack_bytes) : undefined,
          disasmCount: args.disasm_count !== undefined ? Number(args.disasm_count) : undefined,
          includeCustom: args.include_custom !== false,
          includeChipWindow: args.include_chip_window === true,
          chipWindowAddress: args.chip_window_address !== undefined ? parseHexOrDecimal(args.chip_window_address) : undefined,
          chipWindowBytes: args.chip_window_bytes !== undefined ? Number(args.chip_window_bytes) : undefined,
        });
        const markdown = renderPostmortemMarkdown(report);

        const fs = await import('fs');
        if (args.json_file) {
          fs.writeFileSync(String(args.json_file), JSON.stringify(report, null, 2), 'utf8');
        }
        if (args.markdown_file) {
          fs.writeFileSync(String(args.markdown_file), markdown, 'utf8');
        }

        return { content: [{ type: 'text', text: JSON.stringify({
          message: 'Postmortem captured',
          json_file: args.json_file ?? null,
          markdown_file: args.markdown_file ?? null,
          stop: report.stop ?? null,
          pc: (report.cpu as { PC?: string } | undefined)?.PC ?? null,
          a7: (report.cpu as { A7?: string } | undefined)?.A7 ?? null,
        }, null, 2) }] };
      }

      case 'winuae_custom_registers': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const { data } = await readCustomRegisterData(protocol);

        const lines: string[] = ['Amiga Custom Registers ($DFF000-$DFF1FE):'];
        for (let offset = 0; offset < 0x200; offset += 2) {
          const name = CUSTOM_REGS[offset];
          if (name) {
            const value = data.readUInt16BE(offset);
            lines.push(`  $DFF${offset.toString(16).padStart(3, '0').toUpperCase()} ${name.padEnd(10)} = ${hex16(value)}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'winuae_machine_snapshot': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const snapshot = buildMachineSnapshot({});

        if (args.include_cpu !== false) {
          snapshot.cpu = buildCpuSnapshot(await protocol.readRegisters());
        }

        if (args.include_custom !== false) {
          const { data, unreadableChunkOffsets } = await readCustomRegisterData(protocol);
          snapshot.custom = buildCustomRegisterSnapshot(data, CUSTOM_REGS, unreadableChunkOffsets);
        }

        const chipWindow = normalizeMemoryWindow({
          address: args.chip_ram_address !== undefined ? parseHexOrDecimal(args.chip_ram_address) : undefined,
          bytes: args.chip_ram_bytes,
        }, 0x000000);
        const fastWindow = normalizeMemoryWindow({
          address: args.fast_ram_address !== undefined ? parseHexOrDecimal(args.fast_ram_address) : undefined,
          bytes: args.fast_ram_bytes,
        }, 0x200000);

        if (chipWindow || fastWindow) {
          snapshot.memory = {};
        }

        if (chipWindow) {
          try {
            const data = await readMemoryWindowChunked(protocol, chipWindow);
            snapshot.memory!.chip = buildMemoryWindowSnapshot(chipWindow, data);
          } catch (error) {
            snapshot.memory!.chip = buildMemoryWindowErrorSnapshot(chipWindow, error);
          }
        }

        if (fastWindow) {
          try {
            const data = await readMemoryWindowChunked(protocol, fastWindow);
            snapshot.memory!.fast = buildMemoryWindowSnapshot(fastWindow, data);
          } catch (error) {
            snapshot.memory!.fast = buildMemoryWindowErrorSnapshot(fastWindow, error);
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
      }

      case 'winuae_bitmap_decode': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const request = normalizeBitmapDecodeRequest({
          width: Number(args.width),
          height: Number(args.height),
          depth: Number(args.bitplanes),
          rowBytes: args.row_bytes,
          layout: args.interleaved === false ? 'planar' : 'interleaved',
          colorMode: args.extra_half_brite === true ? 'ehb' : 'auto',
          palette: args.palette,
        });
        const outputFormat = args.output_format ?? 'png';
        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const protocol = connection.getProtocol();
            const bitmapData = await protocol.readMemory(addr, request.bytesToRead);

            let customSnapshot;
            if ((args.use_custom_palette ?? true) && (!args.palette || args.palette.length === 0)) {
              const { data, unreadableChunkOffsets } = await readCustomRegisterData(protocol, true);
              customSnapshot = buildCustomRegisterSnapshot(data, CUSTOM_REGS, unreadableChunkOffsets);
            }

            const decoded = decodePlanarBitmap(bitmapData, {
              width: request.width,
              height: request.height,
              depth: request.depth,
              rowBytes: request.rowBytes,
              layout: request.layout,
              colorMode: request.colorMode,
            }, customSnapshot, args.palette);

            if (outputFormat === 'rgba') {
              const rgbaHex = rgbaToHex(decoded.rgba);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify(buildBitmapDecodeResponse(decoded, addr, undefined, rgbaHex), null, 2),
                }],
              };
            } else {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
              const fileName = args.filepath ?? `winuae-bitmap-${timestamp}.png`;
              const { resolve } = await import('path');
              const os = await import('os');
              const fs = await import('fs');
              const outputPath = path.isAbsolute(fileName) ? resolve(fileName) : path.join(os.tmpdir(), fileName);
              fs.writeFileSync(outputPath, encodePngRgba(decoded.width, decoded.height, decoded.rgba));
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify(buildBitmapDecodeResponse(decoded, addr, outputPath), null, 2),
                }],
              };
            }
          } catch (error) {
            lastError = error;
            if (isTransientWinUaeTransportError(error) && attempt < 2) {
              traceErr(`winuae_bitmap_decode: transient transport error, retrying (${attempt + 1}/2)`, error);
              try {
                if (connection?.connected) {
                  await connection.disconnect(false);
                }
              } catch (disconnectError) {
                traceErr('winuae_bitmap_decode: disconnect before retry failed', disconnectError);
              }

              trace('winuae_bitmap_decode: reconnecting WinUAE GDB session for retry (non-intrusive)');
              const previousAttempts = process.env.WINUAE_GDB_MAX_ATTEMPTS;
              const previousDelay = process.env.WINUAE_GDB_DELAY_MS;
              process.env.WINUAE_GDB_MAX_ATTEMPTS = process.env.WINUAE_GDB_RECONNECT_MAX_ATTEMPTS || '20';
              process.env.WINUAE_GDB_DELAY_MS = process.env.WINUAE_GDB_RECONNECT_DELAY_MS || '500';
              try {
                await connection.connectExisting({ forceBreak: false, initializeStopped: false });
              } finally {
                if (previousAttempts === undefined) delete process.env.WINUAE_GDB_MAX_ATTEMPTS;
                else process.env.WINUAE_GDB_MAX_ATTEMPTS = previousAttempts;
                if (previousDelay === undefined) delete process.env.WINUAE_GDB_DELAY_MS;
                else process.env.WINUAE_GDB_DELAY_MS = previousDelay;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
              trace('winuae_bitmap_decode: retry connection established');
              continue;
            }
            throw error;
          }
        }

        throw lastError instanceof Error ? lastError : new Error('winuae_bitmap_decode failed');
      }

      case 'winuae_memory_pattern_search': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const request = normalizeMemoryPatternSearchRequest({
          address: parseHexOrDecimal(args.address),
          length: Number(args.length),
          patternHex: String(args.pattern_hex),
          strideBytes: args.stride_bytes,
          repeatCount: args.repeat_count,
          maxResults: args.max_results,
        });
        const data = await protocol.readMemory(request.address, request.length);
        const candidates = searchMemoryPattern(data, request);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(buildMemoryPatternSearchResponse(request, candidates), null, 2),
          }],
        };
      }

      case 'winuae_copper_disassemble': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const length = args.length || 256;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const decoded = decodeCopperList(data, addr);
        return { content: [{ type: 'text', text: `Copper list at ${hex32(addr)}:\n${decoded}` }] };
      }

      case 'winuae_disassemble': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const count = args.count || 20;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, count * 2);
        const disasm = disassembleM68k(data, addr, count);
        return { content: [{ type: 'text', text: disasm }] };
      }

      case 'winuae_screenshot': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { resolve } = await import('path');
        const os = await import('os');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const filename = args.filename ?? args.filepath ?? `winuae-screen-${timestamp}.png`;
        const filepath = path.isAbsolute(filename) ? resolve(filename) : path.join(os.tmpdir(), filename);
        const captureMode = String(args.capture_mode ?? 'internal');
        const protocol = connection.getProtocol();
        const inlineImage = args.inline !== false;
        const withImage = (text: string) => {
          const content: any[] = [{ type: 'text', text }];
          if (inlineImage) {
            try {
              content.push({ type: 'image', data: fs.readFileSync(filepath).toString('base64'), mimeType: 'image/png' });
            } catch (e) {
              content[0].text += `\n(inline image unavailable: ${e instanceof Error ? e.message : String(e)})`;
            }
          }
          return { content };
        };
        const sessionInfo = connection.getSessionInfo();
        const screenshotTimeoutMs = Math.max(
          5000,
          parseInt(process.env.WINUAE_SCREENSHOT_TIMEOUT_MS || '30000', 10) || 30000
        );

        if (captureMode !== 'host_window') {
          try {
            const winPath = filepath.replace(/\//g, '\\');
            // Upstream writes the raw frame buffer with the genlock key in alpha;
            // aspect and alpha are handled here.
            const caps = await protocol.sendMonitorJson('capabilities', 5000);
            await protocol.sendMonitorCommand(`screenshot ${winPath}`, screenshotTimeoutMs);
            const resolution = Number(caps?.display?.resolution ?? 0);
            const vresolution = Number(caps?.display?.vresolution ?? 0);
            const fixed = fixScreenshotPng(fs.readFileSync(filepath), resolution, vresolution, {
              aspect: args.aspect !== false,
              keepAlpha: args.alpha === true,
            });
            if (fixed.processed) fs.writeFileSync(filepath, fixed.png);
            return withImage(JSON.stringify({
              file: filepath,
              capture_mode: 'internal_buffer',
              alpha: fixed.alphaKept,
              width: fixed.processed ? fixed.width : null,
              height: fixed.processed ? fixed.height : null,
              raw_width: fixed.processed ? fixed.rawWidth : null,
              raw_height: fixed.processed ? fixed.rawHeight : null,
              display: { resolution, vresolution, x_scale: Math.pow(2, fixed.xShift) },
              note: fixed.processed ? undefined : 'PNG format not recognised; returned unprocessed',
            }, null, 2));
          } catch (error) {
            // No silent fallback: a host-window grab is a different picture (DPI
            // scaled, croppable, occludable), so the caller decides to accept it.
            const message = error instanceof Error ? error.message : String(error);
            return {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: 'internal_capture_failed',
                  capture_mode: captureMode,
                  monitor_error: message,
                  next_step: "Retry winuae_screenshot with capture_mode: 'host_window' to grab the visible WinUAE window instead. That capture follows the host desktop, so it is affected by display scaling and by anything covering the window.",
                }, null, 2),
              }],
            };
          }
        }

        const windowCapture = captureWinUAEWindow(filepath, sessionInfo.trackedProcessId ?? undefined);
        return withImage(JSON.stringify({
          file: filepath,
          capture_mode: 'host_window',
          process_id: windowCapture.processId,
          method: windowCapture.method,
          width: windowCapture.width,
          height: windowCapture.height,
          title: windowCapture.title,
          capture_region: windowCapture.captureRegion,
        }, null, 2));
      }

      case 'winuae_disassemble_full': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const count = args.count ?? 20;
        const protocol = connection.getProtocol();
        const n = Math.max(1, Math.min(100, Number(count)));
        const textReply = await protocol.sendMonitorCommand(`disasm ${addr.toString(16)} ${n}`, 10000);
        return { content: [{ type: 'text', text: textReply }] };
      }

      case 'winuae_postmortem_capture': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const report = await buildPostmortemReport({
          protocol,
          customRegs: CUSTOM_REGS,
        }, {
          stopReply: args.stop_reply ? String(args.stop_reply) : undefined,
          stackBytes: args.stack_bytes !== undefined ? Number(args.stack_bytes) : undefined,
          disasmCount: args.disasm_count !== undefined ? Number(args.disasm_count) : undefined,
          includeCustom: args.include_custom !== false,
          includeChipWindow: args.include_chip_window === true,
          chipWindowAddress: args.chip_window_address !== undefined ? parseHexOrDecimal(args.chip_window_address) : undefined,
          chipWindowBytes: args.chip_window_bytes !== undefined ? Number(args.chip_window_bytes) : undefined,
        });

        const payload: Record<string, unknown> = {
          report,
        };

        if (args.json_file || args.markdown_file) {
          const fs = await import('fs');
          const pathModule = await import('path');
          if (args.json_file) {
            const jsonPath = pathModule.resolve(String(args.json_file));
            fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
            payload.json_file = jsonPath;
          }
          if (args.markdown_file) {
            const markdownPath = pathModule.resolve(String(args.markdown_file));
            fs.writeFileSync(markdownPath, renderPostmortemMarkdown(report), 'utf8');
            payload.markdown_file = markdownPath;
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'winuae_exec_chunk': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        await protocol.pause();
        const addr = parseHexOrDecimal(args.address);
        const hexRaw = String(args.hex || '').replace(/\s+/g, '');
        if (hexRaw.length % 2 !== 0) {
          throw new Error('winuae_exec_chunk: hex string must have even length');
        }
        if (!/^[0-9a-fA-F]*$/.test(hexRaw)) {
          throw new Error('winuae_exec_chunk: hex must contain only hex digits');
        }
        const buf = Buffer.from(hexRaw, 'hex');
        await protocol.writeMemory(addr, buf);
        const pcVal = args.pc !== undefined ? parseHexOrDecimal(args.pc) : addr;
        await protocol.writeRegister(17, pcVal >>> 0);
        if (args.sp !== undefined) {
          await protocol.writeRegister(15, parseHexOrDecimal(args.sp) >>> 0);
        }
        const doCont = args.continue_after !== false;
        if (doCont) {
          await protocol.continue();
        }
        return {
          content: [
            {
              type: 'text',
              text: `Wrote ${buf.length} bytes at ${hex32(addr)}, PC=${hex32(pcVal)}${args.sp !== undefined ? ` A7=${hex32(parseHexOrDecimal(args.sp))}` : ''}. ${doCont ? 'CPU continued.' : 'CPU left paused.'}`,
            },
          ],
        };
      }

      case 'winuae_run_program': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { file, entry = '0x40000' } = args;
        const { readFileSync, existsSync } = await import('fs');
        const { resolve } = await import('path');
        const absPath = resolve(file);
        if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
        if (isDiskImage(absPath)) throw new Error('Use winuae_insert_disk for disk images');
        const fileData = readFileSync(absPath);
        const entryAddr = parseHexOrDecimal(entry);
        const protocol = connection.getProtocol();
        await protocol.writeMemory(entryAddr, fileData);
        await protocol.writeRegister(17, entryAddr); // PC
        await protocol.continue();
        return { content: [{ type: 'text', text: `Loaded ${fileData.length} bytes at ${hex32(entryAddr)} and started. Call winuae_wait_stop to wait for breakpoint.` }] };
      }

      case 'winuae_findproc': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const name = String(args.name ?? '').trim();
        const reply = await protocol.sendMonitorJson('tasks', 10000);
        const tasks = (reply?.tasks ?? []).map((t: any) => ({
          address: hex32(t.address), name: String(t.name ?? ''), list: t.list, type: t.type, state: t.state,
        }));
        if (!name) {
          return { content: [{ type: 'text', text: JSON.stringify({ truncated: reply?.truncated, tasks }, null, 2) }] };
        }
        const fold = (v: string) => v.toLowerCase();
        const leaf = (v: string) => v.replace(/^.*[:/]/, '');
        const matches = [];
        for (const t of tasks) {
          let segInfo: Awaited<ReturnType<typeof readSegments>> | null = null;
          if (t.type === 13) { // NT_PROCESS
            try { segInfo = await readSegments(protocol, parseInt(t.address, 16)); } catch { segInfo = null; }
          }
          const names = [t.name, segInfo?.command ?? ''].filter(Boolean);
          if (names.some((n) => fold(n) === fold(name) || fold(leaf(n)) === fold(name))) {
            matches.push({
              ...t,
              command: segInfo?.command,
              segments: segInfo?.segments.map((g) => ({ index: g.index, address: hex32(g.address), size: g.size })),
            });
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(matches.length ? { matches } : { matches: [], note: `no task named ${name}`, tasks }, null, 2) }] };
      }

      case 'winuae_process_break': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const action = String(args.action ?? 'status');
        if (action === 'name') {
          if (!args.value) throw new Error('value (program name) is required');
          await protocol.sendMonitorCommand(`process-break name ${String(args.value)}`, 10000);
        } else if (action === 'address') {
          if (args.value === undefined) throw new Error('value (Process address) is required');
          await protocol.sendMonitorCommand(`process-break address ${mhex(parseHexOrDecimal(args.value))}`, 10000);
        } else if (action === 'clear') {
          await protocol.sendMonitorCommand('process-break clear', 10000);
        } else if (action !== 'status') {
          throw new Error(`Unknown action: ${action}`);
        }
        const status = await protocol.sendMonitorJson('process-break status', 10000);
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }

      case 'winuae_monitor': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const command = String(args.command ?? '').trim();
        if (!command) throw new Error('command is required');
        const text = await protocol.sendMonitorCommand(command, Number(args.timeout_ms ?? 15000));
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* plain text */ }
        return { content: [{ type: 'text', text: pretty }] };
      }

      case 'winuae_input_key': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { scancode, state = 1 } = args;
        const sc = parseHexOrDecimal(scancode);
        if (sc >= 0x68) throw new Error(`Keycode ${hex8(sc)} out of range (raw keycodes are below 0x68)`);
        const st = state ? 1 : 0;
        const protocol = connection.getProtocol();
        await protocol.sendMonitorCommand(`input event 0 0 ${mhex(sc)} ${st}`, 5000);
        return { content: [{ type: 'text', text: `Sent key scancode ${hex8(sc)} ${st ? 'press' : 'release'}` }] };
      }

      case 'winuae_input_event': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const kind = Number(args.kind);
        const port = Number(args.port ?? 0);
        const code = parseHexOrDecimal(args.code);
        const value = Number(args.value ?? 1);
        const protocol = connection.getProtocol();
        const reply = await protocol.sendMonitorCommand(`input event ${mhex(kind)} ${mhex(port)} ${mhex(code)} ${mhex(value)}`, 5000);
        return { content: [{ type: 'text', text: reply }] };
      }

      case 'winuae_input_joy': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { port = 0, action, state = 1 } = args;
        const controls: Record<string, number> = { left: 0, right: 1, up: 2, down: 3, fire: 4, '2nd': 5, '3rd': 6 };
        const control = controls[String(action)];
        if (control === undefined) throw new Error(`Unknown action: ${action}`);
        const st = state ? 1 : 0;
        const protocol = connection.getProtocol();
        await protocol.sendMonitorCommand(`input event 2 ${mhex(Number(port))} ${control} ${st}`, 5000);
        return { content: [{ type: 'text', text: `Sent joy port ${port} ${action} ${st ? 'press' : 'release'}` }] };
      }

      case 'winuae_input_mouse': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { mode, dx = 0, dy = 0, button = 0, state = 1 } = args;
        const port = Number(args.port ?? 0);
        const protocol = connection.getProtocol();
        if (mode === 'move') {
          // One event carries at most +-127 counts per axis.
          for (const [axis, total] of [[0, Number(dx)], [1, Number(dy)]] as const) {
            let left = Math.trunc(total);
            while (left !== 0) {
              const step = Math.max(-127, Math.min(127, left));
              await protocol.sendMonitorCommand(`input event 1 ${mhex(port)} ${axis} ${mhex(step)}`, 5000);
              left -= step;
            }
          }
          return { content: [{ type: 'text', text: `Mouse move dx=${dx} dy=${dy}` }] };
        }
        if (mode === 'abs') {
          throw new Error('Absolute mouse positioning is not available in the upstream WinUAE GDB server; use mode=move');
        }
        if (mode === 'button') {
          const st = state ? 1 : 0;
          const control = [4, 5, 6][Number(button)];
          if (control === undefined) throw new Error(`Unknown button: ${button}`);
          await protocol.sendMonitorCommand(`input event 2 ${mhex(port)} ${control} ${st}`, 5000);
          return { content: [{ type: 'text', text: `Mouse button ${button} ${st ? 'press' : 'release'}` }] };
        }
        throw new Error(`Invalid mode: ${mode}`);
      }

      case 'winuae_amiga_input_state': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const symbolInfo = resolveAutomationInputSymbolInfo(args as Record<string, unknown>);
        const address = symbolInfo.kind === 'pointer'
          ? (await protocol.readMemory(symbolInfo.symbolAddress, 4)).readUInt32BE(0)
          : symbolInfo.symbolAddress;
        const buffer = await protocol.readMemory(address, AUTOMATION_INPUT_SIZE);
        return { content: [{ type: 'text', text: JSON.stringify(buildAutomationInputResponse(address, buffer), null, 2) }] };
      }

      case 'winuae_amiga_input_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const symbolInfo = resolveAutomationInputSymbolInfo(args as Record<string, unknown>);
        const address = symbolInfo.kind === 'pointer'
          ? (await protocol.readMemory(symbolInfo.symbolAddress, 4)).readUInt32BE(0)
          : symbolInfo.symbolAddress;
        const preserveExisting = args.preserve_existing !== false;
        const steps = Math.max(1, Number(args.move_steps ?? 1));
        const delayMs = Math.max(0, Number(args.move_delay_ms ?? 0));
        const wantsInterpolatedMove = steps > 1 && args.mouse_x !== undefined && args.mouse_y !== undefined;

        let buffer = preserveExisting || wantsInterpolatedMove
          ? await protocol.readMemory(address, AUTOMATION_INPUT_SIZE)
          : Buffer.alloc(AUTOMATION_INPUT_SIZE, 0x00);

        if (!preserveExisting && !wantsInterpolatedMove) {
          buffer[18] = 0xFF;
        }

        if (wantsInterpolatedMove) {
          const origin = Buffer.from(buffer);
          const startState = buildAutomationInputResponse(address, origin).state as {
            mouseX: number;
            mouseY: number;
          };
          const targetX = Number(args.mouse_x);
          const targetY = Number(args.mouse_y);

          for (let step = 1; step <= steps; step++) {
            const intermediate = Buffer.from(origin);
            const mouseX = Math.round(startState.mouseX + ((targetX - startState.mouseX) * step) / steps);
            const mouseY = Math.round(startState.mouseY + ((targetY - startState.mouseY) * step) / steps);
            applyAutomationInputPatch(intermediate, {
              ...args,
              mouse_x: mouseX,
              mouse_y: mouseY,
            } as Record<string, unknown>);
            await protocol.writeMemory(address, intermediate);
            buffer = intermediate;
            if (delayMs > 0 && step < steps) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        } else {
          buffer = applyAutomationInputPatch(buffer, args as Record<string, unknown>);
          await protocol.writeMemory(address, buffer);
        }

        return { content: [{ type: 'text', text: JSON.stringify(buildAutomationInputResponse(address, buffer), null, 2) }] };
      }

      case 'winuae_amiga_enter_demo': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const address = resolveEnterDemoAddress(args as Record<string, unknown>);
        const value = Buffer.from([0x01, 0x00, 0x00, 0x00]);
        await protocol.writeMemory(address, value);
        return { content: [{ type: 'text', text: JSON.stringify({
          address: hex32(address),
          value_hex: value.toString('hex').toUpperCase(),
          note: 'g_automation_enter_demo set to 1 (little-endian int).',
        }, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${errorMessage}` }] };
  }
}

// ─── MCP Server Setup ────────────────────────────────────────────────

const server = new Server(
  {
    name: 'winuae-emu',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args || {});
});

// Handle shutdown
process.on('SIGINT', async () => {
  if (connection?.connected) {
    await connection.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (connection?.connected) {
    await connection.disconnect();
  }
  process.exit(0);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const { trace } = await import('./trace.js');
  trace('MCP server running');
  trace(`config: winuaePath=${config.winuaePath} exe=${process.env.WINUAE_EXE || 'winuae-gdb.exe'} port=${config.gdbPort}`);
}

main().catch((error) => {
  console.error('[MCP WinUAE] Fatal error:', error);
  process.exit(1);
});
