import { describe, expect, it } from 'vitest';
import { CappedLog, GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';

describe('GameLogReducer', () => {
  it('coalesces interleaved verbose lines with changing Wine addresses', () => {
    const output: string[] = [];
    let time = 0;
    const reducer = new GameLogReducer((line) => output.push(line), false, () => time);
    for (let index = 0; index < 1_000; index += 1) {
      reducer.push(`00e0:fixme:gdkc:x_user_XUserGetState iface 00006FFFFC1D04A0, state ${index.toString(16).padStart(16, '0')} stub!`);
      reducer.push('65874.496:00dc:01f4:fixme:vkd3d-proton:vk_samples_from_dxgi_sample_desc: Unhandled sample count 0.');
    }
    reducer.push('00e0:err:module:import_dll Library dxgi.dll not found');
    reducer.push('xodus-savesync: cloud 1 downloaded 1 uploaded 0');
    time = 11_000;
    reducer.push('00e0:fixme:gdkc:x_user_XUserGetState iface 00006FFFFC1D04A0, state 0000000000C9F6B0 stub!');
    reducer.flush();
    expect(output.filter((line) => line.includes('Suppressed'))).toHaveLength(2);
    expect(output.length).toBe(8);
    expect(output).toContain('00e0:err:module:import_dll Library dxgi.dll not found');
    expect(output).toContain('xodus-savesync: cloud 1 downloaded 1 uploaded 0');
    expect(output.join('\n')).toContain('Suppressed 999 repeated fixme:gdkc');
    expect(output.join('\n')).toContain('Suppressed 998 repeated fixme:vkd3d-proton');
  });

  it('evicts stale signatures instead of passing new ones through raw once full', () => {
    const output: string[] = [];
    let time = 0;
    const reducer = new GameLogReducer((line) => output.push(line), false, () => time);
    for (let index = 0; index < 3; index += 1) reducer.push('0124:fixme:seh:OutputDebugStringA "asset 0 loaded"');
    for (let index = 1; index < 512; index += 1) reducer.push(`0124:fixme:seh:OutputDebugStringA "asset ${index} loaded"`);
    time = 11_000;
    for (let index = 0; index < 100_000; index += 1) reducer.push('0124:fixme:vkd3d-proton:skip_dword_unknown: Skipping 0x1 unknown DWORDs.');
    // asset 0 is written twice and its one suppressed line is reported on eviction.
    expect(output[513]).toContain('Suppressed 1 repeated fixme:seh:OutputDebugStringA "asset 0 loaded"');
    reducer.flush();
    expect(output).toHaveLength(517);
    expect(output.at(-1)).toContain('Suppressed 99998 repeated fixme:vkd3d-proton:skip_dword_unknown');
  });

  it('collapses new signatures into a shared slot while every slot is in active use', () => {
    const output: string[] = [];
    const reducer = new GameLogReducer((line) => output.push(line), false, () => 0);
    for (let index = 0; index < 512; index += 1) reducer.push(`0124:fixme:seh:OutputDebugStringA "asset ${index} loaded"`);
    for (let index = 0; index < 100_000; index += 1) reducer.push('0124:fixme:vkd3d-proton:skip_dword_unknown: Skipping 0x1 unknown DWORDs.');
    reducer.flush();
    expect(output).toHaveLength(515);
    expect(output.at(-1)).toContain('Suppressed 99998 repeated diagnostics beyond 512 distinct signatures');
  });

  it('does not thrash when a cycle of more than 512 signatures repeats', () => {
    const output: string[] = [];
    let time = 0;
    const reducer = new GameLogReducer((line) => output.push(line), false, () => time);
    for (let cycle = 0; cycle < 200; cycle += 1) {
      for (let index = 0; index < 600; index += 1) {
        reducer.push(`0124:fixme:cycle:line ${index}`);
        time += 1;
      }
    }
    reducer.flush();
    // 512 signatures and the shared slot each write two lines; the rest are
    // the usual per-interval summaries, not raw lines.
    expect(output.filter((line) => !line.startsWith('Suppressed'))).toHaveLength(1_026);
    expect(output.length).toBeLessThan(10_000);
  });

  it('keeps recently repeated signatures when evicting', () => {
    const output: string[] = [];
    let time = 0;
    const reducer = new GameLogReducer((line) => output.push(line), false, () => time);
    reducer.push('0124:fixme:hot:repeat stub');
    for (let index = 0; index < 600; index += 1) {
      reducer.push(`0124:fixme:cold:line ${index}`);
      reducer.push('0124:fixme:hot:repeat stub');
      time += 100;
    }
    expect(output.filter((line) => line === '0124:fixme:hot:repeat stub')).toHaveLength(2);
  });

  it('keeps full output in explicit verbose mode', () => {
    const output: string[] = [];
    const reducer = new GameLogReducer((line) => output.push(line), true);
    for (let index = 0; index < 100; index += 1) reducer.push('00e0:fixme:gdkc:repeated stub');
    reducer.flush();
    expect(output).toHaveLength(100);
  });
});

describe('CappedLog', () => {
  it('stops at the byte limit and writes the last lines on end', () => {
    const output: string[] = [];
    const log = new CappedLog((text) => output.push(text), 11, 2);
    log.push('12345\n');
    log.push('é\n');
    log.push('x\n');
    log.push('omitted\n');
    log.push('kept\n');
    log.push('exit code 5\n');
    expect(output).toEqual(['12345\n', 'é\n', 'x\n', expect.stringContaining('Log size limit')]);
    log.end();
    expect(output.slice(4)).toEqual([expect.stringContaining('Omitted 1 lines'), 'kept\n', 'exit code 5\n']);
  });

  it('bounds the kept tail by bytes as well as lines', () => {
    const output: string[] = [];
    const log = new CappedLog((text) => output.push(text), 0, 200, 10);
    for (let index = 0; index < 5; index += 1) log.push(`line ${index}\n`);
    log.end();
    expect(output.slice(1)).toEqual([expect.stringContaining('Omitted 4 lines'), 'line 4\n']);
  });

  it('defaults to a 64 MB limit', () => {
    let bytes = 0;
    let notices = 0;
    const log = new CappedLog((text) => { if (text.startsWith('Log size limit of 64 MB')) notices += 1; else bytes += text.length; });
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 65; index += 1) log.push(chunk);
    expect(bytes).toBe(64 * 1024 * 1024);
    expect(notices).toBe(1);
  });

  it('writes everything when uncapped', () => {
    const output: string[] = [];
    const log = new CappedLog((text) => output.push(text), Infinity);
    for (let index = 0; index < 100; index += 1) log.push('x'.repeat(1_000));
    log.end();
    expect(output).toHaveLength(100);
  });
});

describe('gameLoggingEnvironment', () => {
  it('reduces default Wine/vkd3d debug output without overriding user choices', () => {
    expect(gameLoggingEnvironment({})).toMatchObject({ WINEDEBUG: '-fixme', VKD3D_DEBUG: 'warn', VKD3D_SHADER_DEBUG: 'warn' });
    expect(gameLoggingEnvironment({ WINEDEBUG: '+relay', VKD3D_DEBUG: 'trace' })).toMatchObject({ WINEDEBUG: '+relay', VKD3D_DEBUG: 'trace', VKD3D_SHADER_DEBUG: 'warn' });
    expect(gameLoggingEnvironment({ XODUS_NEXUS_VERBOSE_LOGS: '1' })).not.toHaveProperty('WINEDEBUG');
  });

  it('keeps full diagnostics when verbose logging is enabled in Settings', () => {
    const environment = gameLoggingEnvironment({}, true);
    expect(environment).toEqual({ XODUS_NEXUS_VERBOSE_LOGS: '1' });
  });
});

describe('gameWindowEnvironment', () => {
  it('preserves Steam Input identity, mappings and explicit controller overrides unchanged', () => {
    const source = { SteamAppId: '3950783330', SteamGameId: '16968485195965530112',
      SteamVirtualGamepadInfo: '/sample/virtual-pad', SteamVirtualGamepadInfo_Proton: '/sample/proton-pad',
      SDL_GAMECONTROLLERCONFIG: 'sample mapping', SDL_GAMECONTROLLER_IGNORE_DEVICES: '0x054c/0x0ce6',
      PROTON_DISABLE_HIDRAW: '0x054c/0x0ce6' };
    expect(gameWindowEnvironment(source)).toEqual(source);
    expect(gameWindowEnvironment({})).toEqual({});
  });
  it('drops launcher identity but preserves the display and cloud bridge', () => {
    expect(gameWindowEnvironment({ DESKTOP_STARTUP_ID: 'launcher', XDG_ACTIVATION_TOKEN: 'launcher-token', XDG_DESKTOP_FILE_NAME: 'xodus-nexus', GIO_LAUNCHED_DESKTOP_FILE: '/tmp/xodus.desktop', APPDIR: '/tmp/.mount_Xodus', APPIMAGE: '/tmp/Xodus.AppImage', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XODUS_BRIDGE_KEY: 'secret' }))
      .toEqual({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XODUS_BRIDGE_KEY: 'secret' });
  });
});
