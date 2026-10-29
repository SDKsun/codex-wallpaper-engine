# 从源码构建

## 环境

- Windows 10/11 x64，Git，Node.js 24 或更新版本。
- .NET SDK 10；运行管理器还需要 .NET Desktop Runtime 10 x64。
- Windows PowerShell 5.1 或 PowerShell 7，以及可在 PATH 中找到的 `tar`。
- 首次构建需要访问固定的 GitHub 源码提交、npm 包地址和 .NET 恢复源。

没有 npm 安装依赖或自动安装钩子。运行 `node scripts/prepare-vendor.mjs` 会校验补丁，获取固定 DSH 提交及固定完整性摘要的 WebWallGL 包，再由原版构建脚本生成五个浏览器模块。已有且摘要匹配的依赖会复用；如果目录存在但内容不同，脚本会停止，保护开发改动。

```powershell
node scripts/prepare-vendor.mjs
node scripts/prepare-vendor.mjs --check
```

## Windows 管理器与完整插件

使用可信 Node.js 发行包中的 `node.exe` 和配套 `LICENSE`。例如：

```powershell
.\scripts\build-plugin.ps1 `
  -NodeExe 'C:\path\to\node-distribution\node.exe' `
  -NodeLicense 'C:\path\to\node-distribution\LICENSE'
```

省略 `-NodeExe` 时使用 PATH 中的 Node；省略 `-NodeLicense` 时查找同目录的 `LICENSE`。Node 许可证文件须与嵌入版本对应。本仓库保留的一份 Node 许可对应开发验证时的 24.15.0；不要据此替其他版本作匹配声明。

构建脚本在 `build/` 下获取固定 Codex Dynamic Skin 提交并校验、应用本地补丁，以 .NET 10 生成 framework-dependent 管理器，然后生成独立输出目录。它还会填充 Git 忽略的源插件 `engine/` 和 `manager/`，以供测试。

默认输出为 `dist/build-<时间>-<标识>/`；也可传入一个尚不存在的 `-OutputDirectory`。已有输出不会被删除或覆盖。

输出目录包含：

```text
.agents/plugins/marketplace.json
gpt-wallpaper/
  plugin.json
  mcp.json
  engine/
  manager/
  scripts/
  skills/
  ui/
  vendor/
LICENSE
```

通过当前 Codex 客户端支持的本地 marketplace 或本地插件方式导入输出目录。未验证的客户端版本可能没有同样的入口，请以客户端实际提供的导入功能为准。构建脚本本身不会修改当前插件缓存或重启 Codex。

## 验证

```powershell
npm test
npm run check:publication
```

首次执行完整测试前应完成管理器构建，因为测试需要受控 Windows 引擎资源。常规测试使用隔离状态目录，不把配置写入真实用户背景。原生窗口最终验收仍需在实际 Codex 中确认；CI 无法替代。

可选媒体辅助程序集成测试只操作其 mock provider：

```powershell
$env:GPT_MEDIA_BRIDGE_INTEGRATION = '1'
node --test tests/media-bridge.test.mjs
```

这项测试可能首次下载并校验固定的官方媒体辅助程序，不会向真实播放器发送控制。

## 发布边界

Git 仓库只提交源码、补丁、锁定信息、测试和文档。生成的依赖目录、二进制、用户配置、日志和截图不入库。第三方角色与插画保留上游权利说明；生成本地插件不等同于取得其再分发或商用授权。需要分发二进制时，另行核对目标资产许可、构建提交和完整摘要，不能直接把本机缓存打包上传。
