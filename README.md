# Codex Wallpaper Engine

[English](README.en.md) · [构建说明](docs/BUILDING.md) · [兼容范围](docs/COMPATIBILITY.md)

把本机 Wallpaper Engine 壁纸用作 Windows Codex 桌面端的背景，并提供可调的玻璃、字体和播放设置。

本项目复用 [DSH Wallpaper Engine](https://github.com/elysia395/dsh-wallpaper-engine) 的宿主模块与六页签设置界面，通过独立的本地服务和原生窗口适配连接 Codex。Windows 启动器基于 [Codex Dynamic Skin](https://github.com/CCDawn/Codex-Dynamic-Skin)。这是第三方适配项目，与 OpenAI、Valve 及上述项目均无官方关联。

## 功能

- 自动发现本机 Steam 工坊壁纸；无需逐项输入项目路径。
- 本地图片、视频与 WebWallGL Scene 背景，支持作者属性和播放控制。
- 原版壁纸库、外观、播放、系统、扩展、关于六页签；支持筛选、预设和轮播。
- 玻璃、颜色、字体、壁纸位置、缩放和镜像；输入框采用单层透明表面。
- 可选系统频谱和 Now Playing；媒体辅助程序从官方来源获取并校验固定 SHA-256。
- 首次启用通过管理器明确确认重启；支持暂停与恢复官方外观。

## 兼容情况

当前目标为 **Windows x64**。已在 Codex `26.1021.3705.0` 的真实窗口验证 Scene 持续渲染、约 30 FPS、动态画面变化以及 3840×2160 视频播放。鼠标粒子和轨迹在独立的严格策略测试窗口验证过，不能据此承诺每张壁纸都兼容。

原生 Web、依赖动态 SceneScript 的场景、DSH 官方同页桌宠联动和终端画布字体仍有限制。管理页面的预览、保存成功或海报显示都不代表真实聊天背景已生效。详见[兼容说明](docs/COMPATIBILITY.md)。

## 从源码使用

需要 Git、Node.js 24+、.NET SDK 10、.NET Desktop Runtime 10 x64，以及 Windows 自带的 PowerShell 和 `tar`。

```powershell
git clone https://github.com/SDKsun/codex-wallpaper-engine.git
cd codex-wallpaper-engine
node scripts/prepare-vendor.mjs
.\scripts\build-plugin.ps1 -NodeLicense 'C:\path\to\node-distribution\LICENSE'
npm test
```

`-NodeLicense` 必须来自与构建所用 `node.exe` 相同的 Node.js 发行包；它不是本项目的 MIT 文件。完整步骤和常见问题见[构建说明](docs/BUILDING.md)。

构建结果位于 `dist/build-<时间>-<标识>/`，包含完整的 `gpt-wallpaper` 插件和 `.agents/plugins/marketplace.json`。使用当前 Codex 客户端支持的本地插件或本地 marketplace 导入方式导入该目录。源代码目录里的插件注册信息不包含已编译管理器，不能代替构建输出。

导入后，在聊天中调用 wallpaper 技能或输入“打开可视化壁纸库”，选择本机壁纸。首次启用点击管理器中的“启动 / 重新应用”，阅读提示并确认重启。以后可通过“壁纸设置”或默认快捷键 `Ctrl+Alt+W` 调整。

本仓库目前提供源码构建流程，不把上游发布包当作本项目的预编译版本。

## 数据与实现

用户配置、壁纸库状态和运行时缓存保存在 `%USERPROFILE%\.codex\wallpaper-local`，不存入本仓库。显式隔离目录用于测试。壁纸文件留在原位置，不随本项目分发。

本地服务只监听回环地址。原生适配使用限定主框架和路径的 Runtime 通信，不修改 Codex 安装包、全局 `fetch` 或 CSP。构建脚本只生成文件，不安装插件、不重启当前应用。字体和玻璃的适配标记及样式在卸载时恢复。

## 开发

```powershell
npm run prepare:vendor
npm test
npm run check:publication
```

依赖提交、npm 完整性摘要、适配补丁摘要和生成文件摘要统一登记在 [dependencies.lock.json](dependencies.lock.json)。原版 DSH 浏览器模块由其固定源码的构建脚本生成；不是手工修改压缩产物。

## 许可与致谢

本项目新增代码采用 [MIT](LICENSE)。上游代码和依赖各自的许可证、作者与修改说明见 [THIRD-PARTY-NOTICES.md](plugins/gpt-wallpaper/THIRD-PARTY-NOTICES.md)。感谢 DSH Wallpaper Engine、Codex Dynamic Skin、WebWallGL、media-bridge 和 React 的作者与贡献者。

第三方角色、插画、字体、视频和 Workshop 壁纸不因本项目的 MIT 许可证而重新授权。本仓库不上传用户壁纸、聊天截图或上游角色素材；构建过程按固定版本从上游获取其依赖，使用和再分发时仍须遵守相应权利与许可。
