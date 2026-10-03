#!/usr/bin/env node
// Exercises the gdbserver 'monitor screenshot' command under genlock (32bpp BGRA),
// both without and with the alpha keyword.
import fs from 'fs';
import path from 'path';
import { WinUAEConnection } from '../dist/winuae-connection.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = path.resolve('test-output', 'screenshot-genlock');
fs.mkdirSync(outDir, { recursive: true });

const conn = new WinUAEConnection({
  winuaePath: process.env.WINUAE_PATH || 'B:/Source/CLionProjects/WinUAE/build/Win32',
  configFile: process.env.WINUAE_CONFIG || 'C:/Users/Public/Documents/Amiga Files/WinUAE/Configurations/Prevue.uae',
  gdbPort: 2345,
});
const report = { cases: {} };
try {
  await conn.connect({ forceBreak: false, initializeStopped: false });
  await sleep(Number(process.env.BOOT_WAIT_MS || 25000));
  const protocol = conn.getProtocol();
  for (const [name, kw] of [['rgb', ''], ['alpha', 'alpha '], ['raw', 'raw ']]) {
    const f = path.join(outDir, `${name}.png`).replace(/\//g, '\\');
    try { fs.unlinkSync(f); } catch {}
    const hex = await protocol.sendMonitorCommand(`screenshot ${kw}${f}`, 30000);
    const text = Buffer.from(hex, 'hex').toString('utf8');
    const st = fs.existsSync(f) ? fs.statSync(f) : null;
    let png = null;
    if (st) {
      const h = Buffer.alloc(26);
      const fd = fs.openSync(f, 'r'); fs.readSync(fd, h, 0, 26, 0); fs.closeSync(fd);
      png = { magic: h.subarray(1, 4).toString(), w: h.readUInt32BE(16), h: h.readUInt32BE(20), bitDepth: h[24], colorType: h[25] };
    }
    report.cases[name] = { reply: text, bytes: st?.size ?? null, png };
  }
} catch (e) {
  report.error = String(e?.message || e);
} finally {
  await conn.disconnect(true).catch(() => {});
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
