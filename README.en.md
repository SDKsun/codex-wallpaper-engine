# Codex Wallpaper Engine

[中文](README.md) · [Building](docs/BUILDING.md) · [Compatibility](docs/COMPATIBILITY.md)

Local Wallpaper Engine backgrounds and configurable glass UI for managed Windows Codex sessions through an external native adapter.

**The project combines a control plugin and an external window adapter. An optional resident assistant keeps the original Codex entry: it detects a newly opened ordinary visible window, reopens the application and loads the saved appearance. A brief window restart may be visible. This is not a host-native theme extension; the assistant requires separate opt-in.**

As of 2026-10-29, Codex 26.1021.3705.0 was verified after all application background processes exited: launching the original official application entry let the assistant restore a playing 4K video, mascot and glass effects, with wallpaper settings unchanged. See [Compatibility](docs/COMPATIBILITY.md) for the validation scope and limitations.

This project adapts the host modules and six-tab UI of [DSH Wallpaper Engine](https://github.com/elysia395/dsh-wallpaper-engine), using a local service and a scoped native-window bridge. Its Windows launcher is based on [Codex Dynamic Skin](https://github.com/CCDawn/Codex-Dynamic-Skin). It is independent of OpenAI, Valve and the upstream projects.

## Features

- Automatic discovery of local Steam Workshop wallpapers.
- Local images, videos and WebWallGL scenes, author properties and playback controls.
- Original library, appearance, playback, system, extensions and about tabs, presets and rotation.
- Configurable glass, fonts, color and positioning; a single transparent composer surface.
- A fine 1px glass rim, top-edge highlights and a soft reflected sheen on the composer and settings dialog, preserving native corners, opacity and blur.
- Separate glass surfaces for Library/Sites, Automations, Plugins/Skills and menus, with local contrast and automatic cleanup on page changes.
- The chat project summary card follows sidebar glass settings, with one background layer, readable sections and preserved scrolling.
- Optional system audio spectrum and Now Playing through a pinned, checksum-verified official media helper.
- Explicit first-run restart confirmation, pause and appearance restoration.
- Restores the verified managed wallpaper window when multiple Codex instances exist; background output does not block the manager's startup result.
- An optional separate launcher restores the local resource service and attempts to load the saved appearance; its entries coexist with the official application entry.
- An optional resident assistant reattaches decoration after an ordinary launch, with tray pause/resume/disable controls and restoration of its login startup entry on uninstall.

## Supported scope

The target is **Windows x64**. Real Codex `26.1021.3705.0` verification covered continuously changing scenes at approximately 30 FPS and 3840×2160 video playback. Pointer-driven particles and trails were verified in a separate strict-policy fixture. This does not establish universal wallpaper compatibility.

Native Web, scenes requiring dynamic SceneScript, official same-page DSH pet integration and terminal canvas fonts remain limited. A management-page preview or saved configuration is not proof of native rendering. See [compatibility](docs/COMPATIBILITY.md).

## Build and use

Requirements: Git, Node.js 24+, .NET SDK 10, .NET Desktop Runtime 10 x64, Windows PowerShell and `tar`.

```powershell
git clone https://github.com/SDKsun/codex-wallpaper-engine.git
cd codex-wallpaper-engine
node scripts/prepare-vendor.mjs
.\scripts\build-plugin.ps1 -NodeLicense 'C:\path\to\node-distribution\LICENSE'
npm test
```

`-NodeLicense` must be the license shipped with the Node.js distribution being embedded. See [building instructions](docs/BUILDING.md).

The output `dist/build-<timestamp>-<id>/` contains a complete `gpt-wallpaper` plugin and `.agents/plugins/marketplace.json`. Import this output using your client's supported local-plugin or local-marketplace flow. The source catalog alone does not contain the compiled manager.

Open the wallpaper skill, select a local wallpaper, and confirm the manager's first-run restart. Click the mascot to open its library panel, then use its settings entry at the bottom. Right-click the mascot to open settings directly; `Ctrl+Alt+W` remains available. This repository provides a source-build process; upstream binaries are not presented as this project's release.

To install the optional managed launch path, run `.\scripts\install-launcher.ps1` from the **built** `gpt-wallpaper` directory. It copies the runtime into the user state directory and creates desktop and Start menu `Codex` shortcuts for manually starting a managed session; these can also be pinned to the taskbar. Rerun the installer to update its shortcuts and matching taskbar entries. `-Action Uninstall` restores desktop and Start menu entries while retaining wallpaper settings; unpin the taskbar entry manually in Windows. Official Store application registrations and protocol links remain unchanged; the assistant below observes ordinary launches to reattach decoration.

To retain the original official icon, opt into the resident assistant after installing the stable payload:

```powershell
.\scripts\install-startup-assistant.ps1
node .\scripts\startup-assistant.mjs --restore
```

The assistant has a dedicated per-user login startup entry; plugin initialization also restores an already enabled assistant. It handles only ordinary, argument-free, visible instances started within 15 seconds, revalidating exact process identities. Existing ordinary sessions, deep links, file-open arguments and hidden background launches are preserved. A failed attempt is recorded rather than repeatedly retried. A session that was already open for a long time during installation must be exited before testing a fresh launch.

The tray offers pause, resume and disable-and-exit. Resume affects later launches. Run `.\scripts\install-startup-assistant.ps1 -Action Uninstall` to revoke the assistant and restore its backed-up startup entry. Wallpaper settings and later private configuration or registry edits are retained.

## Implementation and development

User configuration and caches live under `%USERPROFILE%\.codex\wallpaper-local`, outside the repository. Wallpapers stay in their original locations.

The MCP plugin exposes wallpaper-library and settings controls. Appearance loading is performed by a separate local service, debug connection and native-window adapter, rather than an integrated official application startup hook. The service listens on loopback only. Scoped Runtime communication does not modify the official application package, global `fetch` or CSP. The build does not install or restart the active application.

```powershell
npm run prepare:vendor
npm test
npm run check:publication
```

[dependencies.lock.json](dependencies.lock.json) pins source commits, npm integrity, adapter patches and generated files. Original browser bundles are rebuilt from pinned upstream sources.

## License

New integration code is [MIT](LICENSE). See [third-party notices](plugins/gpt-wallpaper/THIRD-PARTY-NOTICES.md) for upstream licensing and credits. Third-party character art, fonts, videos and Workshop wallpapers are not relicensed by this project. User media, chat screenshots and upstream character assets are not uploaded to this repository; source preparation fetches dependencies from their pinned upstream locations.
