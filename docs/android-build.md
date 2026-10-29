# Android 安装包构建

Android 版使用 Capacitor 8.6，将 `frontend/dist-local` 独立版打包进 APK。安装后直接使用，不需要电脑运行服务、Java 后端、账号或 API 密钥。工作内容保存在这台设备本地；不同设备不会自动同步。

应用 ID 为 `com.workflowos.personal`，显示名称为 **WorkFlow OS**。当前 `versionName` 为 `0.2.0`，`versionCode` 为 `2`。支持 Android 7.0 / API 24 及以上，并要求 Android System WebView / Chrome WebView 107 或更新版本。

## 构建环境

| 项目 | 本仓库配置 |
| --- | --- |
| Node.js | 22.12 或更新版本 |
| JDK | 21 |
| Capacitor | 8.6.0 |
| Android Gradle Plugin | 8.13.0 |
| Gradle Wrapper | 8.14.3 |
| compileSdk / targetSdk | 36 / 36 |
| minSdk | 24 |
| SDK Build Tools | 35.0.0，AGP 默认版本 |

安装 Android SDK 命令行工具或 Android Studio，并设置 `ANDROID_HOME`。使用 Android Studio 时请把 Gradle JDK 也设为 JDK 21。安装 SDK：

```sh
sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0"
sdkmanager --licenses
```

SDK 和 JDK 要求参见 [Capacitor 环境配置](https://capacitorjs.com/docs/getting-started/environment-setup)；Build Tools 默认版本参见 [Android Gradle Plugin 8.13 兼容表](https://developer.android.com/build/releases/agp-8-13-0-release-notes)。项目实际的 SDK 和 Gradle 值分别记录在 `mobile/android/variables.gradle` 与 `mobile/android/gradle/wrapper/gradle-wrapper.properties`。

## 先准备独立版网页

从仓库根目录运行：

```sh
npm ci --prefix frontend
npm run build:local --prefix frontend
npm run android:sync --prefix frontend
```

`android:sync` 会把真实构建内容复制进 Android 项目，并生成 Capacitor 的配置与依赖引用。不要把开发服务器地址设置到 `server.url`，也不要用普通联网版 `frontend/dist` 替代 `dist-local`。原生环境不会注册网页 Service Worker，更新后会加载安装包内的新资源。

## 发布签名

发布构建必须提供四个环境变量：

| 变量 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_PATH` | 发布 keystore 的完整路径 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 发布签名别名 |
| `ANDROID_KEY_PASSWORD` | 对应私钥密码 |

缺少任一变量、keystore 不存在、密码或别名错误都会使发布构建失败。构建不会自动使用调试签名或产出未签名的发布包。密码由本地环境或 CI Secret 提供，不要写入源代码、Gradle 文件、命令参数或发布附件。

首次需要创建签名时，可以在受保护的目录运行下列交互式命令，由 `keytool` 提示输入密码：

```sh
keytool -genkeypair -keystore /secure/workflow-os-release.jks \
  -alias workflow-os -keyalg RSA -keysize 3072 -validity 10000
```

妥善保存同一份 keystore、别名和密码；后续更新必须继续使用相同的签名。仓库忽略 keystore、APK、AAB、SDK 本机路径和复制生成的网页资源。

## 生成与核对

在签名环境变量就绪后运行：

```sh
cd mobile/android
./gradlew --no-daemon assembleRelease
```

APK 生成位置：`mobile/android/app/build/outputs/apk/release/app-release.apk`。需要 Play 商店提交格式时可运行 `./gradlew --no-daemon bundleRelease`，输出为 `app/build/outputs/bundle/release/app-release.aab`。APK 可直接分发安装；AAB 用于商店，不能当作 APK 安装。

用 Android SDK 核对签名：

```sh
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

发布前还需在 Android 设备或模拟器验证首次打开、触摸移动与连线、工作做法、完整流程复制和退出后数据保留。仅完成源代码或静态构建检查不能视为已完成这些设备测试。

## 原生边界与图标

应用通过 `https://localhost` 读取安装包内资源，关闭明文 HTTP、混合内容、远端 WebView 导航白名单和发布版调试。外部链接由系统浏览器处理。当前仅声明 Capacitor WebView 所需的 `INTERNET` 权限；选择图片等文件使用系统文件选择器，不申请整个存储空间或相册的读取权限。

桌面和 Android 使用同一个产品图标。修改 `desktop/assets/icon.png` 后，可用 Python 与 Pillow 更新 Android 五档启动图标、自适应前景、圆形图标和旧版启动画面：

```sh
python3 mobile/android/tools/render-icons.py
```
