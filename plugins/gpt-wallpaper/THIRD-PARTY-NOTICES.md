# Third party notices

Wallpaper engine and Windows manager: CCDawn/Codex-Dynamic-Skin v1.7.3,
commit 5a0e74043b63ed9518ab37cdcf6865340a57006c.
Source: https://github.com/CCDawn/Codex-Dynamic-Skin/tree/v1.7.3
MIT license: LICENSE-UPSTREAM.

The manager is built from the pinned C# sources plus the complete local patch
in patches/codex-scene-addon.patch, using .NET 10, framework-dependent.
It requires .NET Desktop Runtime 10 x64. This is not an upstream Release binary.
The build embeds a caller-supplied trusted Node.js executable and its matching
license. NODE-LICENSE.txt in this source tree corresponds to the verified
Node.js v24.15.0 build; generated packages receive the build's supplied license.

Local additions: MCP control, directory rotation, plugin manifests, tests and
Chinese instructions. These additions use the MIT license in LICENSE.
The embedded Windows injector and shared renderer/CSS now include local scene
addon patches. This is a locally modified build, not an upstream release.

WebWallGL 3.0.0 (MIT), https://github.com/oneincase/webwallgl.
Registry archive integrity: sha512-If5DUW3hHeWOyyhvswHkycWm0U5mWJUpKb4ws/J+jrwK3gUbmpoyyACfezKClrcpMB8u2UNyl/ni3M0Z2gjjww==
Bundled browser engine SHA-256: 2f86ab955f3377e2fa2cfd5ffa72f5813fe8f6e4a272295fed36f4c1e626b1e5.
License: vendor/webwallgl/LICENSE. Retrieved with npm pack --ignore-scripts;
the self-contained browser bundle is served locally, with no runtime CDN dependency.
WebWallGL's own code is MIT; its declared media dependency Mediabunny uses
MPL-2.0: https://github.com/Vanilagy/mediabunny.
The pinned DSH lockfile resolves Mediabunny 1.61.3, whose corresponding source
and license are https://github.com/Vanilagy/mediabunny/tree/v1.61.3 and
https://github.com/Vanilagy/mediabunny/blob/v1.61.3/LICENSE.
That lockfile does not establish the version embedded in WebWallGL's prebuilt
global bundle. This source-only repository does not include that bundle or
Mediabunny code. Before distributing a generated binary package containing
covered code, verify its embedded version and provide its corresponding
source, MPL text and notices; WebWallGL's MIT file alone is insufficient.

DSH Wallpaper Engine 1.4.0 source, MIT,
https://github.com/elysia395/dsh-wallpaper-engine,
commit 7ba44b2424e55b70fe28fea753a7abf27ae7cdb3.
Explicit source preparation fetches the pinned host modules and rebuilds the
five browser bundles under the Git-ignored vendor/dsh-engine/source directory.
The original LICENSE and asset provenance documents remain in that dependency.
The code-only public repository does not upload upstream character artwork,
illustrations, optional pet animations, user media or private screenshots.
Character and artwork rights are not relicensed by MIT; review the upstream
asset notices before redistributing any generated package.
Adapter changes and the pinned source identity are recorded in
vendor/dsh-engine/upstream.json and patches/dsh-codex-adapter.patch. The fixed
WebWallGL local-assets delta is patches/webwallgl-replacements.json. Exact
source, archive and patch identities are in the root dependencies.lock.json.
This is a local Codex adaptation and is not an
upstream DSH release. Character/artwork rights remain with their respective
creators; see the original asset attribution files. No Workshop wallpaper assets
are bundled or redistributed.

React and ReactDOM 18.3.1, MIT, https://github.com/facebook/react.
Local browser UMD bundles and their licenses are shipped under ui/runtime/.

No SceneViewer or other GPL sidecar is bundled. Existing local Wallpaper Engine
video files remain in their original locations and are not included in this package.
