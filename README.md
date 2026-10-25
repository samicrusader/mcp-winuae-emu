# mcp-winuae-emu

An [MCP](https://modelcontextprotocol.io/) server that provides Amiga 68k debugging and development tools through the WinUAE emulator. It connects to WinUAE's built-in GDB server (`gdb_server.cpp` / `gdb_monitor.cpp`, enabled with `debugging_features=gdbserver`) via GDB Remote Serial Protocol (RSP), giving AI assistants direct read-write access to the emulated Amiga hardware.

> **Server dialect.** This branch speaks the monitor dialect of upstream WinUAE's GDB server (JSON replies, hex arguments; see `capabilities`). It no longer targets Bartman's/axewater's `barto_gdbserver` or WinUAE-DBG: `protect`, `rewind`, `side_read`, `debugperiph`, `train` and `profile` were removed because that server has no equivalent. Reads, writes and monitor queries that need a halted CPU are wrapped in interrupt/retry/resume automatically.

## What it does

This server lets an AI assistant (Claude, Cursor, etc.) help develop Amiga software (A500, A1200, CD32) by:

- **Launching and debugging**: Load executables, set breakpoints, single-step, read/write memory and registers
- **Capturing output**: Screenshot the emulator display, full m68k disassembly
- **Simulating input**: Inject keyboard, mouse and joystick events
- **Disk management**: Insert/eject floppy images, load binaries into memory
- **Hardware inspection**: Custom chip registers, Copper list disassembly
- **Structured snapshots**: One-shot JSON capture of CPU/custom state plus bounded RAM windows

All via MCP tool calls, enabling the AI to run, test, and iterate on Amiga programs.

**Guía "cuándo usar" (para IA):** `Amiga-Cpp/docs/debugging/DEBUG-WINUAE-V2-GUIDE.md`
(inventario, síntoma→herramienta, periférico `0xB70000` + checkpoint profiler,
verificación y limitaciones).

Related project docs:
- WinUAE-DBG (stub GDB, atribución Bartman/axewater/David, reglas RSP): [BARTMAN-VSCODE-Y-EVOLUCION.md](../WinUAE-DBG/doc/BARTMAN-VSCODE-Y-EVOLUCION.md#atribucion-bartman-vs-fork) (ruta típica si clonaste `WinUAE-DBG` junto a este repo; ajusta el prefijo si tu layout difiere).
- Cursor-Amiga-C roadmap: [amiga-implementation-roadmap.md](../Cursor-Amiga-C/doc/amiga-implementation-roadmap.md)
- Cursor-Amiga-C battery/spec: [amiga-test-battery-spec.md](../Cursor-Amiga-C/doc/amiga-test-battery-spec.md)

## Quick Start

### 1. WinUAE binary: releases vs WinUAE-DBG build

You can use a **`winuae-gdb.exe`** from:

1. **[axewater/WinUAE releases](https://github.com/axewater/WinUAE/releases)** (or the branch described in [HANDOVER.md](https://github.com/axewater/WinUAE/blob/gdb-write-commands/HANDOVER.md)), or  
2. **Your own build** from a **WinUAE-DBG** tree (this workspace’s `WinUAE-DBG` clone: same RSP stub family as the axewater fork; use that tree’s `build.bat` and `doc/BARTMAN-VSCODE-Y-EVOLUCION.md` for Bartman vs fork extensions and MCP compatibility notes).

Point `WINUAE_PATH` at the directory that contains `winuae-gdb.exe`. The MCP server merges GDB-related CLI flags when launching; WinUAE **v4.10.x** expects `debugging_features=gdbserver` on the **command line** (see Technical notes at the end of this README).

### 2. Install the MCP server

```bash
git clone https://github.com/axewater/mcp-winuae-emu.git
cd mcp-winuae-emu
npm install
npm run build
```

### 3. Add to Claude Code

Add to your MCP settings (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "winuae-emu": {
      "command": "node",
      "args": ["C:/path/to/mcp-winuae-emu/dist/index.js"],
      "env": {
        "WINUAE_PATH": "C:/apps/winuae",
        "WINUAE_CONFIG": "C:/apps/winuae/Configurations/A500-Dev.uae"
      }
    }
  }
}
```

### 4. Provide a Kickstart ROM and config

You need a valid Amiga Kickstart ROM file (e.g., Kickstart 1.3 for A500) and a WinUAE `.uae` config file. A minimal config:

```ini
cpu_type=68000
chipset=ocs
chipmem_size=1
kickstart_rom_file=C:\path\to\kickstart.rom
```

The server reads your config, merges in GDB-required settings, and launches `winuae-gdb.exe` automatically.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WINUAE_PATH` | `C:\apps\winuae` | Directory containing `winuae-gdb.exe` |
| `WINUAE_CONFIG` | `<WINUAE_PATH>\Configurations\A500-Dev.uae` | Path to your `.uae` config file |
| `WINUAE_GDB_PORT` | `2345` | GDB server TCP port |
| `WINUAE_DEBUG` | `0` | Set to `1` to enable GDB protocol debug logging |
| `WINUAE_USE_ACK` | (unset) | Set to `1` to disable no-ack mode; some stubs need acks for memory write (M) |
| `WINUAE_MEMORY_WRITE_NO_PAUSE` | (unset) | Set to `1` to skip pausing the CPU before write (try with CPU running) |
| `WINUAE_SESSION_IDLE_TIMEOUT_MS` | `0` | Idle timeout for the reusable session. `0` disables auto-disconnect. |
| `WINUAE_SESSION_IDLE_ACTION` | `detach` | On idle timeout: `detach` drops GDB but leaves WinUAE running; `shutdown` also closes the launched emulator process. |

## Tools

### Connection

| Tool | Description |
|---|---|
| `winuae_connect` | Launch WinUAE and connect to GDB server. Optional `config_file` overrides `WINUAE_CONFIG` for this session. Supports non-intrusive attach with `force_break=false` and `initialize_stopped=false`. |
| `winuae_connect_existing` | Attach to GDB on port 2345 (WinUAE already running). Supports non-intrusive attach with `force_break=false` and `initialize_stopped=false`. |
| `winuae_disconnect` | Disconnect from GDB and optionally leave the emulator process running (`stop_emulator=false`) |
| `winuae_status` | Return JSON session status, health, tracked floppies, reusable-session policy, and tracked PID when this MCP launched WinUAE |
| `winuae_session_config` | Configure reusable-session idle timeout and whether idle expiry detaches or shuts WinUAE down |
| `winuae_memory_map` | Return the current memory map from `monitor memory-map` (address, size, ram/rom/io, chip) |
| `winuae_qoffsets` | Return the LoadSeg segments of the current (or a given) AmigaDOS process from `monitor segments`; `text` = first segment, what qOffsets used to report |
| `winuae_monitor` | Send any monitor command and get its decoded reply (`capabilities`, `tasks`, `exception`, `guest-output`, `checkpoint`, `condition`, `dma-watch`, ...) |

### Memory

| Tool | Description |
|---|---|
| `winuae_memory_read` | Read memory bytes as hex |
| `winuae_memory_write` | Write hex bytes to memory |
| `winuae_memory_dump` | Hex + ASCII dump (like a hex editor) |
| `winuae_load` | Load a binary file into Amiga memory. For AmigaHunk executables, applies relocations and loads hunks at contiguous addresses. |

### CPU

| Tool | Description |
|---|---|
| `winuae_registers_get` | Read all m68k registers (D0-D7, A0-A7, SR, PC) |
| `winuae_registers_set` | Write registers (any subset of D0-D7, A0-A7, SR, PC) |
| `winuae_step` | Single-step N instructions |
| `winuae_continue` | Resume execution |
| `winuae_pause` | Pause execution and read registers |
| `winuae_reset` | Pause CPU and read current register state |

### Breakpoints & Watchpoints

| Tool | Description |
|---|---|
| `winuae_breakpoint_set` | Set a software breakpoint at an address |
| `winuae_breakpoint_clear` | Remove a breakpoint |
| `winuae_breakpoint_conditional_wait` | Software-assisted conditional breakpoint helper that evaluates register/custom/memory predicates on each stop until one matches. |
| `winuae_watchpoint_set` | Break on memory read/write/access |
| `winuae_watchpoint_clear` | Remove a watchpoint |
| `winuae_watchpoint_set_ext` | Watchpoint with source filter and value predicates (`monitor watch add` / `watch range`): exact 8/16/32-bit access or a byte range, `source` (cpu/copper/blitter/dma/bpl/spr/audio/disk...), `value`, `mask`, `must_change`, `nobreak` |
| `winuae_watchpoint_list` | List those watchpoints with their ids (`monitor watch list`) |
| `winuae_watchpoint_last` | Last watchpoint hit from the server's 64-entry event log; `all`/`clear` for the whole log |
| `winuae_watchpoint_clear_ext` | Remove one watchpoint by id or all (`all=true`) |
| `winuae_emulator_status` | Execution state, frame, vpos/hpos, cycles, warp, display resolution (works while running) |
| `winuae_trace` | Instruction history (`monitor history on/off/read`): last N executed instructions with registers |
| `winuae_base` | Runtime segment bases of the current process (`monitor segments`), read-only |
| `winuae_findproc` | List Exec tasks (`monitor tasks`); with `name`, the matching process and its segments |
| `winuae_process_break` | One-shot breakpoint at a program's entry point once it is loaded (`monitor process-break`) |
| `winuae_print` | Print a value from emulated memory (read client-side); with `mapPath` resolves a symbol and **simple struct fields via DWARF** of the `.elf` (e.g. `g_game.m_scene.m_scroll_x`, arrays `[N]`, deref). Offline resolution verified by `scripts/verify-dwarf.mjs` |

### Amiga Hardware (core tools)

| Tool | Description |
|---|---|
| `winuae_machine_snapshot` | Return a JSON snapshot with CPU registers, custom registers, and optional bounded chip/fast RAM windows. |
| `winuae_postmortem_capture` | Capture a crash/stop postmortem bundle with parsed stop reason, CPU registers, stack dump, disassembly around PC, and optional snapshot data. |
| `winuae_bitmap_decode` | Decode planar bitmap data from Amiga memory to PNG or inline RGBA using palette colors from args or current custom registers. |
| `winuae_memory_pattern_search` | Search a RAM range for an exact byte pattern and optionally score repeated matches using a configurable stride. |
| `winuae_custom_registers` | Read all $DFF000–$DFF1FE with names. Use to get BPL/AUD/DMACON/DIW/DDF/COLOR/SPR/COP1; derive bitmap and sample addresses, then use memory_read to dump. |
| `winuae_copper_disassemble` | Decode Copper list at address (e.g. COP1LCH/L from custom_registers). |
| `winuae_memory_read` | Read any address/length (hex). Use for bitplane dumps, sample dumps, or chunked pattern search. |
| `winuae_memory_write` | Write hex to any address. Use $DFF100 (BPLCON0) or $DFF096 (DMACON) with 2-byte big-endian to toggle bitplanes/sprites. |
| `winuae_memory_dump` | Hex+ASCII dump; inspect regions or search in output. |
| `winuae_disassemble` | Basic m68k disassembly (raw words) |
| `winuae_disassemble_full` | Full m68k disassembly via WinUAE sm68k (requires monitor command support) |

### Capture & Run

| Tool | Description |
|---|---|
| `winuae_screenshot` | Capture display to PNG from WinUAE's frame buffer (`monitor screenshot`), scaled to display aspect from `capabilities.display` (`aspect=false` for the raw buffer); genlock key kept as alpha only with `alpha=true`. `capture_mode=host_window` grabs the visible window instead. |
| `winuae_run_program` | Load binary into memory, set PC, and start execution. For testing executables. |
| `winuae_exec_chunk` | Write hex-encoded machine code at `address`, set PC (and optional SP/A7), optionally `continue_after`. |
| `winuae_profile_ollama` | **Canal lateral (2346) + Ollama local**: captura un perfil sin tocar GDB, extrae frames + resumen técnico y devuelve un informe markdown (pre-análisis técnico + descripción de visión) usando SOLO el modelo local. Útil para que la IA verifique si lo que se renderiza encaja con lo pretendido (p.ej. tiles de un scroll montándose bien). No gasta tokens de nube. |
| `winuae_input_key` | Simulate Amiga keyboard: raw scancode press/release (e.g. 0x45=Return). |
| `winuae_input_event` | Send one raw guest input event (`monitor input event <kind> <port> <code> <value>`): keyboard, mouse axis or port control |
| `winuae_amiga_input_state` | Read and decode Cursor-Amiga-C `g_automation_input` from Amiga memory. |
| `winuae_amiga_input_set` | Drive Cursor-Amiga-C via its software automation buffer with mouse coordinates, buttons, key slot, and joystick flags. |
| `winuae_amiga_enter_demo` | Set `g_automation_enter_demo=1` inside Cursor-Amiga-C to enter the demo/effect path. |

## How it works

1. **Launch**: Reads your `.uae` config, merges GDB settings, spawns `winuae.exe -f <config> -s debugging_features=gdbserver -s gdb_port=<port> -s use_gui=no`. The server halts the CPU when a client attaches; the MCP resumes it unless `initialize_stopped` is set
2. **Connect**: Retries TCP connection to `localhost:2345` until the GDB server is ready
3. **Protocol**: Communicates via [GDB RSP](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Protocol.html) -- packet framing, checksums, ack mode, register/memory commands, breakpoint commands, etc.

### GDB monitor commands (qRcmd)

Upstream WinUAE's server answers monitor commands with hex-encoded JSON; numbers in arguments are hex. Commands used by the tools:

| Monitor command | Used by |
|---|---|
| `capabilities` | screenshot (display resolution), `winuae_emulator_status` |
| `execution-status`, `warp [on\|off]` | `winuae_emulator_status`, `winuae_warp` (both work while running) |
| `memory-map` | `winuae_memory_map` |
| `segments [process]`, `tasks`, `process-break ...` | `winuae_qoffsets`, `winuae_base`, `winuae_print`, `winuae_findproc`, `winuae_process_break` |
| `watch add\|range\|list\|remove\|last\|events` | `winuae_watchpoint_*_ext` |
| `history on\|off\|read <n>` | `winuae_trace` |
| `screenshot <path>`, `disasm <addr> <count>` | `winuae_screenshot`, `winuae_disassemble_full`, postmortem |
| `floppy insert <n> <path>`, `floppy eject <n>` | `winuae_insert_disk`, `winuae_eject_disk` |
| `input event <kind> <port> <code> <value>` | `winuae_input_key`, `_event`, `_joy`, `_mouse` |

### Frame profiling

Removed: upstream WinUAE's GDB server has no `profile` command. `winuae_profile_ollama` below needs the WinUAE-DBG side channel (port 2346), which upstream WinUAE does not have either.

### Profile + análisis con Ollama local

`winuae_profile_ollama` hace el bucle completo sin competir por el socket GDB: se captura por el **canal lateral** (2346, con `lock assist`), se parsea el binario (mismo formato que `vscode-amiga-debug`), se extraen los frames y `profile-summary.json`, y se pide a Ollama local un **pre-análisis técnico** (registros custom, DMA, bitplanes, ciclos — modelo de texto) más una **descripción de visión** de la secuencia (hoja de contacto con ffmpeg, o por frame). Todo con tokens del modelo local:

```
winuae_profile_ollama num_frames=4 prompt="scroll horizontal fino; comprobar que los tiles se ensamblan sin salto de 16px"
```

Parámetros: `num_frames`, `out_dir`, `prompt`/`prompt_file` (qué se espera ver), `model` (visión, def `qwen3-vl:8b-instruct-q8_0`), `text_model` (def `qwen3:8b`), `base` (def `http://127.0.0.1:11434`), `mode` (`meta|frames|montage|all`), `frames` (subconjunto), `wait_cmd`/`wait_contains` (esperar READY antes de capturar), `side_port` (def 2346).

Requisitos: WinUAE-DBG con el canal lateral activo (lanzar con `WINUAE_GDB_PERSIST_LISTENER=1`) y Ollama local en ejecución. El equivalente en scripts del repo `Amiga-Cpp` es `tools/profile/ai-analyze.mjs` (orquestador que imprime el informe por stdout).

### What you can do with the core tools (for the AI)

There are no separate “gfx_state”, “audio_state”, “bitmap_read”, “memory_search”, or “custom_write” tools. Use the **core** tools as follows:
- **Consistent machine snapshot**: Call `winuae_machine_snapshot` to get CPU + custom registers in one structured response, with optional chip/fast RAM windows. Each RAM window is capped at **16384 bytes** to keep MCP payloads bounded.
- **Bitmap decode**: Call `winuae_bitmap_decode` with `address`, `width`, `height`, `bitplanes`, and optionally `row_bytes`, `interleaved`, `palette`, or `use_custom_palette=true`. Output can be PNG (`filepath`) or inline RGBA for small images.
- **Crash/postmortem bundle**: Call `winuae_postmortem_capture` after a suspicious stop, requester, or crash to preserve stop reason, CPU, stack, disassembly around PC, and optional custom/chip snapshot data in JSON/Markdown.
- **Pattern search**: Call `winuae_memory_pattern_search` with a RAM range plus `pattern_hex`. Add `stride_bytes` and `repeat_count` when searching repeated row signatures or record layouts; results come back as scored candidates with addresses.
- **Relocatable AmigaHunk load**: `winuae_load` detects classic AmigaHunk executables, assigns contiguous load addresses, applies `RELOC32`, and writes relocated hunks before verification.
- **Memory-map introspection**: Call `winuae_memory_map` before a fixed-address or "metal" load. In the current A500 battery profile, Fast RAM is visible at runtime and should be preferred for bare-metal experiments, but the low end of a bank may still be a bad place to collide with live system allocations.
- **Conditional breakpoints**: `winuae_breakpoint_conditional_wait` uses a normal software breakpoint plus server-side predicate checks on registers, custom registers, or exact memory bytes. The current WinUAE GDB stub does not expose native GDB-expression conditional breakpoints, so this helper is explicitly software-assisted.
- **Software input intermediary**: `winuae_amiga_input_set` writes the `g_automation_input` buffer used by Cursor-Amiga-C, which is more reliable for screen-coordinate mouse movement and scripted UI navigation than blind host-side deltas alone.

- **Graphics extraction**: Call `winuae_custom_registers`; from the output read BPL1PTH/L (offsets 0xE0/0xE2; 24-bit address = high byte of PTH << 16 | PTL), BPLCON0 (0x100; low 3 bits = num bitplanes), DIW/DDF (0x8E–0x94) to compute row_bytes and height. Then call `winuae_memory_read` with that address and length (row_bytes × height × num_planes) to get raw planar data; decode to image externally.
- **Sound extraction**: From `winuae_custom_registers`, read AUD0–3 LCH/LCL (0xA0–0xD2) for 24-bit sample address and LEN (words). Call `winuae_memory_read` at that address with length LEN×2 bytes to get raw 8-bit samples.
- **Toggle bitplanes or sprites** ([coppenheimer](https://github.com/losso3000/coppenheimer)-style): Use `winuae_memory_write` with address $DFF096 (DMACON; clear bit 9 to disable sprites, bit 8 to disable bitplanes) or $DFF100 (BPLCON0) and 2-byte hex value (big-endian, e.g. `0200`).
- **Search memory for a pattern**: Call `winuae_memory_read` in chunks (e.g. 4096 bytes) over the range, then check the returned hex for your pattern; or use `winuae_memory_dump` and search in the text output.
- **Copper list**: Get COP1LCH/L from custom_registers (0x80/0x82), then `winuae_copper_disassemble` at that address.

### Technical notes

- `winuae_machine_snapshot` returns JSON text and caps each optional RAM window at **16 KiB**; requests above that are truncated and marked in the response. It has been live-validated in this workspace against a visible WinUAE session, including CPU/custom capture, a truncated 16 KiB chip RAM window, and region-specific fast RAM errors without breaking the whole snapshot. RAM windows are read in 1 KiB chunks to avoid stub resets on large reads.
- `winuae_postmortem_capture` is intended for postmortem analysis after `winuae_pause`, `winuae_wait_stop`, requesters, or test failures. Its GDB signal-to-exception mapping is heuristic, especially on plain 68000 targets, so treat it as a debugging aid rather than a perfect architectural exception decoder.
- `winuae_bitmap_decode` supports 1–8 bitplanes, row-interleaved or plane-sequential layouts, and can derive palette from custom COLOR registers. Inline RGBA output is limited to **16384 pixels**; use PNG for larger images.
- `winuae_memory_pattern_search` caps the scanned RAM range at **256 KiB**, the pattern at **8 KiB**, and the result list at **64** candidates to keep MCP responses bounded.
- `winuae_load` now supports a practical subset of AmigaHunk (`HEADER`, `CODE`, `DATA`, `BSS`, `RELOC32`, `END`) for typical toolchain outputs. Unsupported hunk block types still fail fast.
- Direct fixed-address Hunk loading is still marked operationally fragile in this workspace: WinUAE-DBG now exposes `memcfg`, and MCP stores memory-map evidence, but the current live T01 route still crashes the emulator process during post-write verification of some Hunk uploads. That is a known debugger/runtime blocker, not yet a closed test path.
- `winuae_breakpoint_conditional_wait` is a server-side loop over ordinary breakpoint hits; it is useful for automation, but it is not the same as native stub-side conditional expressions.
- `winuae_amiga_input_set` depends on the target Amiga program exporting `g_automation_input` (or on you passing `automation_address`). For Cursor-Amiga-C this is now the preferred path for deterministic mouse/keyboard/joystick automation inside the app.
- Reusable sessions are supported: `winuae_connect` already tries an existing GDB server first, and `winuae_session_config` can keep the emulator open across turns with either `detach` or `shutdown` idle behavior. On the current WinUAE build, the most reliable cross-turn reuse is still an externally launched visible session plus `winuae_connect_existing`.
- For visible-session evidence, `winuae_screenshot` with `capture_mode=host_window` is now the most faithful way to see what the user sees on screen. The helper prioritizes desktop `screen_copy` because `PrintWindow` can report success while returning a black frame for WinUAE.
- `npm run test:adf-matrix` runs the reproducible A-MCP-01 verification matrix (`scripts/a-mcp-01-matrix.mjs`) and writes `report.json` plus `report.md` under `test-output/a-mcp-01-matrix/`.
- `npm run test:snapshot-live` runs the live A-MCP-02 validation (`scripts/a-mcp-02-live.mjs`) and writes `a-mcp-02-live-machine-snapshot.json` plus `a-mcp-02-live-validation-summary.json` under `Cursor-Amiga-C/out/`.
- If `dfN insert/eject` fails while attached through `winuae_connect_existing`, MCP now keeps the requested floppy state for the next managed launch instead of silently spawning a replacement WinUAE instance that it does not control.
- Most tools now try a lightweight auto-attach to an already-running WinUAE GDB server before failing with "Not connected", so a visible session from a previous turn can often be reused without an explicit `winuae_connect_existing`.
- `winuae_screenshot` supports `capture_mode=auto|monitor|internal|host_window`. `monitor/internal` are internal buffer capture modes (preferred for evidence), while `host_window` is Windows-only fallback that captures what is visible on desktop.
- Live check disponible: `npm run test:screenshot-internal-live` (valida qRcmd screenshot interno, firma PNG y dimensiones reportadas por WinUAE-DBG).
- The `-G` flag and `-s` overrides **must** be CLI arguments. This WinUAE build (v4.10.1) ignores `use_gui` and `debugging_features` when set in the config file.
- The GDB server sends `O` packets (console output) on connect. The protocol handler skips these automatically.
- Custom chip register reads use 64-byte chunks because the GDB server has read-size limits for hardware I/O addresses.
- ECS/AGA-only registers ($DFF1C0+) return zeros on OCS chipset configurations.
- CIA registers ($BFE001/$BFD000) are not accessible through the GDB memory read interface.

## Credits

- [WinUAE](https://www.winuae.net/) by Toni Wilen -- the Amiga emulator
- [BartmanAbyss WinUAE fork](https://github.com/BartmanAbyss/WinUAE) -- added the GDB server to WinUAE
- [vscode-amiga-debug](https://github.com/BartmanAbyss/vscode-amiga-debug) by BartmanAbyss -- the VSCode extension that pioneered Amiga GDB debugging, and the reference for this work
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic

## Limitations

- **Windows only** -- requires WinUAE
- **x64 build of WinUAE-DBG**: the x64 binary has a **pre-existing** issue (not caused by the v2.1 monitor extensions): during boot with a GDB client connected, the server does not respond to the handshake and may crash in the JIT/`compemu_support` region (access violation at `0x4002xxxx`). Use the **x86** build (`winuae-gdb.exe`, the default). See `WinUAE-DBG/docs/WINUAE-MONITOR-EXTENSIONS.md` for details.
- **Basic disassembly** -- the disassembler only recognizes a few opcodes (RTS, NOP, RTE, etc.); all others show as `DC.W`
- **No CIA access** -- CIA-A/CIA-B registers are not mapped through the GDB server
- **Single connection** -- the GDB server accepts one client at a time
- **Memory write (M packet):** Some WinUAE GDB builds (e.g. prb28/vscode-amiga-assembly) do not implement the GDB **M** (write memory) packet; `winuae_memory_write` may then timeout. This MCP: pauses the CPU before writing (unless `WINUAE_MEMORY_WRITE_NO_PAUSE=1`), uses a 30s timeout, tries **X** (binary write) if **M** fails, and always logs `[GDB memory] [SEND]` / `[RECV]` to stderr so you can see whether the stub replies. You can try `WINUAE_USE_ACK=1` (disable no-ack mode) in case the stub only responds when acks are on. If it still fails, use a WinUAE build with M support (e.g. [axewater fork](https://github.com/axewater/WinUAE/tree/gdb-write-commands)) or drive the target via an in-program automation buffer (Cursor-Amiga-C `engine_automation_input.h`).

## License

MIT
