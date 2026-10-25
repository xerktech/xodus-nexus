import { describe, expect, it } from 'vitest';
import { GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';

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

  it('never reduces err: lines whose text contains a verbose level', () => {
    const output: string[] = [];
    const reducer = new GameLogReducer((line) => output.push(line), false, () => 0);
    const lines = ['0124:err:ntdll:thing failed:trace:x:y', '0124:err:d3d:fixme:shader:compile failed',
      '65874.496:00dc:01f4:warn:d3d:info:x:y'];
    for (let index = 0; index < 10; index += 1) lines.forEach((line) => reducer.push(line));
    reducer.flush();
    expect(output).toHaveLength(30);
    expect(output.some((line) => line.includes('Suppressed'))).toBe(false);
  });

  it('reduces verbose lines with or without a Wine pid/tid prefix', () => {
    const output: string[] = [];
    const reducer = new GameLogReducer((line) => output.push(line), false, () => 0);
    for (let index = 0; index < 10; index += 1) {
      reducer.push('fixme:vkd3d-proton:func: repeated');
      reducer.push('0124:trace:seh:dispatch repeated');
      reducer.push('  1.234:00dc:01f4:fixme:d3d:padded time');
      reducer.push('0124:1a2b4:info:vkd3d-proton:long tid');
    }
    expect(output).toHaveLength(8);
  });

  it('keeps full output in explicit verbose mode', () => {
    const output: string[] = [];
    const reducer = new GameLogReducer((line) => output.push(line), true);
    for (let index = 0; index < 100; index += 1) reducer.push('00e0:fixme:gdkc:repeated stub');
    reducer.flush();
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
