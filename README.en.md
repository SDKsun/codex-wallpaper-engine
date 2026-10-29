# Codex Wallpaper Engine

[中文](README.md) · [Building](docs/BUILDING.md) · [Compatibility](docs/COMPATIBILITY.md)

Local Wallpaper Engine backgrounds and configurable glass UI for the Windows Codex desktop app.

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
- Restores the verified wallpaper window when multiple Codex instances exist; background output does not block the manager's startup result.

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

## Implementation and development

User configuration and caches live under `%USERPROFILE%\.codex\wallpaper-local`, outside the repository. Wallpapers stay in their original locations.

The service listens on loopback only. Scoped Runtime communication does not modify the official application package, global `fetch` or CSP. The build does not install or restart the active application.

```powershell
npm run prepare:vendor
npm test
npm run check:publication
```

[dependencies.lock.json](dependencies.lock.json) pins source commits, npm integrity, adapter patches and generated files. Original browser bundles are rebuilt from pinned upstream sources.

## License

New integration code is [MIT](LICENSE). See [third-party notices](plugins/gpt-wallpaper/THIRD-PARTY-NOTICES.md) for upstream licensing and credits. Third-party character art, fonts, videos and Workshop wallpapers are not relicensed by this project. User media, chat screenshots and upstream character assets are not uploaded to this repository; source preparation fetches dependencies from their pinned upstream locations.
