---
name: wallpaper
description: 管理当前 Windows ChatGPT/Codex 的图片与视频背景、壁纸透出度、Wallpaper Engine 本地视频、暂停与自动轮播。
---

使用本插件 wallpaper_control 工具执行用户请求。默认用 open_library 启动可视化壁纸库，再用 open_in_codex 的 browser 目标打开返回的 URL，显示在当前聊天侧栏。完整界面自动发现本机 Steam 工坊，直接选择壁纸；基础模式另支持本地图片/MP4/WebM 目录。管理器 open_manager 用于首次启用引擎、确认重启或恢复官方外观。壁纸库管理页面的玻璃效果不代表聊天界面已经生效。

工具不可用时可在此技能所在插件根目录执行 `node scripts/server.mjs --command '{"action":"status"}'`，传 JSON 的方式须遵守当前 shell 的安全引用规则；更推荐通过 stdin 调用 MCP，避免路径转义问题。

工具动作：status、open_library、open_manager、set_wallpaper(path)、set_reveal(percent)、pause、resume、list_themes、use_theme(themeId)、list_wallpaper_engine、use_scene(themeId)、rotation_start(folder,seconds)、rotation_stop、rotation_status。

用户要直接连接 Wallpaper Engine 时：open_library 会自动读取本机 Steam 工坊壁纸库，默认显示原版 DSH 六页签完整界面，无需用户输入路径。完整模式包含上游 Scene、Web、视频、自定义图片与预设、玻璃、字体、扩展和媒体设置；可选能力以实际服务状态为准。基础扫描工具 list_wallpaper_engine 列出 Scene 和视频；用户在聊天按名称换场景时先列出，再 use_scene(themeId) 使用准确 ID 或唯一名称。use_scene 返回的 URL 是壁纸库，不能把场景预览当管理界面。场景使用 WebGL 渲染与被动鼠标/按键转发；预览图或配置保存均不能证明已开始实时渲染。当前聊天的首次显示仍需要管理器确认启用；只有真实 Codex 窗口验收后才可称已生效。暂停/恢复通过现有引擎清理和重新挂载场景，恢复时场景会重新开始。

路径必须由用户指定或通过本地文件选择得到。不要拿含有 UI 的截图当壁纸。不要从网络抓取或运行网页壁纸。

原生背景使用限定主框架和路径的私有 Runtime 通信，不修改 Codex 全局 fetch 或 CSP。Scene 必须检测到真实渲染控制器及持续 FPS，不能把预览图回退判作成功。原生 Web 与依赖动态 SceneScript 的场景仍有兼容限制；管理页面成功预览不代表原生已兼容。当前真实窗口已验收 Scene 与 4K 视频；鼠标效果必须使用本身配置了互动的项目验证，不能用没有鼠标响应的场景声称互动已通过。

set_wallpaper 等只保存配置；watcher 尚未运行时不代表已经显示。首次应用由管理器确认重启；不要在当前任务中擅自结束 ChatGPT/Codex，不要自行调用 RestartExisting。现有客户端未逐版验证；只在真实界面确认后才说壁纸已生效。

自动轮播由本地后台进程执行；最短 30 秒，只轮播指定目录直属的图片/视频。停止轮播仅停止切换，保留当前壁纸。暂停会同时停止轮播；恢复不会自动重新开启轮播。恢复官方外观使用管理器“恢复官方外观”，它可能需要重启。

商店版应用与独立进程统一使用用户目录下 `.codex/wallpaper-local` 保存 GPTWallpaper 和 CodexDreamSkin 状态；显式隔离目录仍可覆盖。管理器和本地服务使用独立进程代理，Codex 重启时会继续运行。初始化会恢复已启用的服务；不自动注册 Windows 启动项。

非 OpenAI 官方插件。原生启动引擎使用 MIT 的 https://github.com/CCDawn/Codex-Dynamic-Skin v1.7.3 并带本地适配补丁；完整壁纸功能复用 https://github.com/elysia395/dsh-wallpaper-engine 的固定源码提交。Scene 渲染使用随包附带的 WebWallGL 3.0.0（MIT）；不同场景的效果兼容性需逐个实测。可选官方 DSH 桌宠联动需要对应宿主插件，不能把内置吉祥物称为已经接通官方桌宠。
