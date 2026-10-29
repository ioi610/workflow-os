# 电脑安装包

电脑端把网页界面与 Electron 一起打包。安装后可以直接启动，不需要 Java、数据库服务器、Node.js 或 API 密钥。流程保存在本机应用数据目录中的 IndexedDB，不会自动上传或与其他设备同步。

| 版本             | 发布文件                                     | 适用设备                                |
| ---------------- | -------------------------------------------- | --------------------------------------- |
| Windows          | `WorkFlow-OS-Windows-x64.exe`                | Windows 10 / 11，Intel 或 AMD 64 位电脑 |
| macOS Apple 芯片 | `WorkFlow-OS-macOS-arm64.dmg` / `.zip`       | macOS 13 及以上，Apple Silicon          |
| macOS Intel      | `WorkFlow-OS-macOS-x64.dmg` / `.zip`         | macOS 13 及以上，Intel Mac              |
| Linux            | `WorkFlow-OS-Linux-x64.AppImage` / `.tar.gz` | 支持 Electron 的 64 位 Linux 桌面系统   |

所有版本使用同一份前端功能。新安装的应用从空白工作区开始。原来通过网页服务器建立的流程不会自动转移到安装包，跨设备或跨版本转移请使用完整流程的复制还原功能。卸载时保留本机应用数据，仍建议在清理系统或换电脑前自行备份。

## 本机打包

需要 Node.js 22.12 或以上。进入项目根目录后执行：

```sh
npm ci
npm ci --prefix frontend
npm run desktop:test
npm run desktop:pack
```

安装包在 `release/`。默认构建当前系统及处理器的版本。macOS 可以指定 `npm run desktop:pack -- --mac --arm64` 或 `--mac --x64`。Windows 和 Linux 安装包由对应系统的 GitHub Actions runner 构建。

打包只包含 `desktop/main.cjs`、`desktop/security.cjs`、图标和 `frontend/dist-local/`，不会带入本机的工作流程、上传文件、数据库、`.env.local` 或 API 密钥。

## GitHub 自动发布

`.github/workflows/distribution.yml` 先运行前端测试、桌面安全测试和独立前端构建检查，再分别构建 Windows、两种 Mac 和 Linux 安装包。所有构建成功后，统一发布到 GitHub Releases，并附上 `SHA256SUMS.txt`。

维护者可以推送与根目录 `package.json` 版本一致的 `vX.Y.Z` 标签，或在 Actions 中手动运行工作流并填写同一版本。发布权限只开放给最后的发布 job。

## 签名与兼容性

当前 Windows 包没有付费代码签名证书，Windows 可能显示“未知发布者”；Mac 仅使用本地 ad-hoc 签名，没有 Apple Developer ID 签名或公证，首次打开可能需要在系统设置的“隐私与安全性”中允许打开。不要关闭系统整体安全保护。若设备受公司管理，请按管理员的安装政策处理。

Linux AppImage 可能需要发行版提供的 FUSE 2 兼容库。无法运行 AppImage 时可选 `.tar.gz`，解压后运行 `workflow-os`。不同 Linux 桌面库的兼容性由其 Electron 运行要求决定。

应用只加载打包好的本地界面，并保留用户提供的 HTTPS 图片和直接视频链接的展示能力。渲染进程启用沙箱、隔离上下文，禁止 Node.js 和任意文件桥接；远程脚本、嵌入式网页播放器和接口请求无法在应用内运行，HTTPS 外部链接在系统浏览器打开。使用本机上传的图片可完全离线查看；远程图片和视频需要联网。仅本地应用主页面可以写入剪贴板和请求持久存储，其他权限请求默认拒绝；网页脚本不能读取剪贴板、访问本地目录或调用命令。

参考：[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-builder 打包文档](https://www.electron.build/docs/)、[GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
