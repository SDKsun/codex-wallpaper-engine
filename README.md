# Codex Wallpaper Engine

[English](README.en.md) · [构建说明](docs/BUILDING.md) · [兼容范围](docs/COMPATIBILITY.md)

通过外部原生适配器，把本机 Wallpaper Engine 壁纸用作 Windows Codex 受管会话的背景，并提供可调的玻璃、字体和播放设置。

**当前实现是 MCP 控制插件、外部原生适配器和独立受管启动器的组合。安装插件后，从原来的官方 Codex 入口正常打开便自动出现装扮的需求尚未实现。替代快捷方式不代表这项启动集成已经完成。**

截至 2026-10-29，已验证受管浏览器进程仍存活时，关闭最后一个窗口再打开可以恢复装扮；完整退出后台进程后的自动恢复尚未完成验收。最近一次直接启动官方应用仍打开了没有装扮的普通实例。

本项目复用 [DSH Wallpaper Engine](https://github.com/elysia395/dsh-wallpaper-engine) 的宿主模块与六页签设置界面，通过独立的本地服务和原生窗口适配连接 Codex。Windows 启动器基于 [Codex Dynamic Skin](https://github.com/CCDawn/Codex-Dynamic-Skin)。这是第三方适配项目，与 OpenAI、Valve 及上述项目均无官方关联。

## 功能

- 自动发现本机 Steam 工坊壁纸；无需逐项输入项目路径。
- 本地图片、视频与 WebWallGL Scene 背景，支持作者属性和播放控制。
- 原版壁纸库、外观、播放、系统、扩展、关于六页签；支持筛选、预设和轮播。
- 玻璃、颜色、字体、壁纸位置、缩放和镜像；输入框采用单层透明表面。
- 输入框和设置对话框带 1px 玻璃细边、顶部高光与渐淡反射，保留原圆角、透明度和模糊参数。
- 资料空间/站点、定时任务、插件/技能页和菜单采用分区玻璃，兼顾壁纸透出与文字对比；随页面切换自动恢复标记。
- 聊天右侧项目信息卡跟随右侧栏玻璃设置，清除内部标题的重复背景，保留分隔线和滚动。
- 可选系统频谱和 Now Playing；媒体辅助程序从官方来源获取并校验固定 SHA-256。
- 首次启用通过管理器明确确认重启；支持暂停与恢复官方外观。
- 多个 Codex 窗口并存时恢复已验证的受管壁纸窗口；后台输出不会阻塞管理器的启动结果。
- 可选独立启动器先恢复本地资源服务，再尝试加载已保存的装扮；其入口与官方应用启动入口分别存在。

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

导入后，在聊天中调用 wallpaper 技能或输入“打开可视化壁纸库”，选择本机壁纸。首次启用点击管理器中的“启动 / 重新应用”，阅读提示并确认重启。以后点击顶部挂件，在壁纸库面板底部进入“壁纸引擎设置”；右键挂件可直接打开设置，默认快捷键 `Ctrl+Alt+W` 保留。

以下步骤安装可选的受管启动入口，用于调用外部适配器；它不会使官方原入口自动加载装扮。在**构建后的** `gpt-wallpaper` 目录运行：

```powershell
.\scripts\install-launcher.ps1
```

安装器把完整运行文件放在用户状态目录，并创建桌面和开始菜单的 `Codex` 快捷方式，也可由用户将其固定到任务栏。该启动器提供一条受管启动路径，不能替代对原应用启动生命周期的集成；完整退出后台进程再启动的场景仍待验收。再次运行安装器会更新它管理的快捷方式及匹配的任务栏入口。`-Action Uninstall` 还原桌面和开始菜单入口，不删除壁纸配置；任务栏固定项需在 Windows 中手动取消固定。官方 Store 注册的应用入口和协议链接不会被改写，当前未实现从这些入口自动接入装扮。

本仓库目前提供源码构建流程，不把上游发布包当作本项目的预编译版本。

## 数据与实现

用户配置、壁纸库状态和运行时缓存保存在 `%USERPROFILE%\.codex\wallpaper-local`，不存入本仓库。显式隔离目录用于测试。壁纸文件留在原位置，不随本项目分发。

MCP 插件提供壁纸库和设置的控制工具；外观加载由独立本地服务、调试连接和原生窗口适配完成，而不是已接入的官方应用启动钩子。本地服务只监听回环地址。原生适配使用限定主框架和路径的 Runtime 通信，不修改 Codex 安装包、全局 `fetch` 或 CSP。构建脚本只生成文件，不安装插件、不重启当前应用。字体和玻璃的适配标记及样式在卸载时恢复。

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
