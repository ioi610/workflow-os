# WorkFlow OS v0.2.0

电脑和手机都能搭建工作流程、记录具体做法，并在图和完整文字之间还原。

- Windows x64：`.exe` 安装向导。
- macOS 13+：Apple Silicon（arm64）与 Intel（x64），分别提供 `.dmg` 和 `.zip`。
- Linux x64：`.AppImage` 和 `.tar.gz`。
- Android 7.0+：正式密钥签名的 APK，需要较新的 Android System WebView（107+）。
- iPhone / iPad：[主屏幕网页应用](https://ioi610.github.io/workflow-os/app/)，使用 Safari「分享 → 添加到主屏幕」；这是 PWA，当前没有 IPA / App Store 版。
- 电脑、手机两套 26 秒 GIF 演示，可在附件中下载。动画为界面示意，使用示例数据。

[统一下载页与演示](https://ioi610.github.io/workflow-os/)

安装版内置完整页面，无需启动 Java / Node 服务，无需账号或 API 密钥。流程和上传图片保存在当前设备；首次打开网页应用需联网，缓存完成后可离线使用。各设备不会自动同步。已有服务端工作内容不会自动搬入安装版；可用「复制全文」和「文字生成流程图」搬移框架及做法文字，上传的图片文件不会随文字迁移，需要重新添加。请保留应用/网站数据，并定期备份重要内容。

电脑安装包未使用 Apple / Windows 开发者证书签名或公证，系统可能提示确认来源；无需关闭系统防护。Android 使用项目固定发布密钥，便于后续覆盖更新。`SHA256SUMS.txt` 包含安装包和演示 GIF 的校验值。

发布流程在对应平台实际打包并检查应用内容，Android APK 通过签名校验；存储、并发保存、原图数据还原、离线缓存及桌面隔离策略有自动测试。尚未在真实手机和所有目标电脑上进行安装体验测试。
