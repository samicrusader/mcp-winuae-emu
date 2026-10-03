#!/usr/bin/env node
// Drives dist/index.js over MCP stdio and checks winuae_screenshot returns an inline image block.
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cfg = process.env.WINUAE_CONFIG || 'C:/Users/Public/Documents/Amiga Files/WinUAE/Configurations/Prevue.uae';
const winuaePath = process.env.WINUAE_PATH || 'B:/Source/CLionProjects/WinUAE/build/Win32';
const outDir = path.resolve('test-output', 'screenshot-inline');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/index.js')],
  env: { ...process.env, WINUAE_PATH: winuaePath, WINUAE_CONFIG: cfg },
});
const client = new Client({ name: 'inline-test', version: '1.0.0' });
const report = { cfg, winuaePath };
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const shot = tools.tools.find((t) => t.name === 'winuae_screenshot');
  report.hasInlineParam = !!shot?.inputSchema?.properties?.inline;
  report.connect = (await client.callTool({ name: 'winuae_connect', arguments: { config_file: cfg, force_break: false, initialize_stopped: false } })).content?.[0]?.text?.slice(0, 300);
  await sleep(8000);
  for (const mode of ['auto', 'host_window']) {
    const r = await client.callTool({ name: 'winuae_screenshot', arguments: { capture_mode: mode, filepath: path.join(outDir, `shot-${mode}.png`).replace(/\//g, '\\') } });
    const img = r.content.find((c) => c.type === 'image');
    report[mode] = {
      blocks: r.content.map((c) => c.type),
      isError: !!r.isError,
      meta: r.content[0]?.text?.slice(0, 400),
      image: img ? { mimeType: img.mimeType, b64len: img.data.length, pngMagic: Buffer.from(img.data, 'base64').subarray(1, 4).toString() } : null,
    };
    if (img) fs.writeFileSync(path.join(outDir, `decoded-${mode}.png`), Buffer.from(img.data, 'base64'));
  }
  const r2 = await client.callTool({ name: 'winuae_screenshot', arguments: { inline: false, filepath: path.join(outDir, 'shot-noinline.png').replace(/\//g, '\\') } });
  report.noInlineBlocks = r2.content.map((c) => c.type);
  // alpha passthrough
  const r3 = await client.callTool({ name: 'winuae_screenshot', arguments: { alpha: true, inline: false, filepath: path.join(outDir, 'shot-alpha.png').replace(/\//g, '\\') } });
  report.alpha = r3.content[0]?.text?.slice(0, 200);
  // forced internal failure: unwritable path must NOT silently fall back
  const r4 = await client.callTool({ name: 'winuae_screenshot', arguments: { filepath: 'Z:\\nosuchdir\\nope.png' } });
  report.failure = { isError: !!r4.isError, blocks: r4.content.map((c) => c.type), text: r4.content[0]?.text };
} catch (e) {
  report.error = String(e?.stack || e);
} finally {
  await client.callTool({ name: 'winuae_disconnect', arguments: { stop_emulator: true } }).catch(() => {});
  await client.close().catch(() => {});
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
