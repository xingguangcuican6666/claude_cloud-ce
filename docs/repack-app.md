# 给官方 App 打补丁,连上你的自建服务器

[`client/repack-app.sh`](../client/repack-app.sh) 把官方 Claude Android App 改成连你自己的 `claude_cloud-ce` 服务器,而不是分发一个改过的 APK 本体——Anthropic 的 App 二进制有版权,我们不分发它,只分发"怎么改"这份脚本,你自己下载官方包、自己打补丁、自己签名、自己装。

## 1. 脚本做什么

1. 把 App 里写死的 `api.anthropic.com` 换成你服务器的地址(host)。
2. (可选)把 App 内置的 Firebase 推送配置换成你自己申请的项目,这样后台推送通知能用。
3. (可选)让 App 信任你的自签 CA 证书(如果服务器没用公网真域名证书)。
4. 用你自己生成的签名库重新签名,产出一组可以直接装机的 APK。

## 2. 前置条件

- 自己从官方渠道下载一份 `.apks` 文件(Google Play 或其它合法来源导出的拆分包)。脚本不内置、不下载、不缓存任何官方 APK。
- 装好 `apktool`、`apksigner`、`keytool`、`unzip`(Android SDK build-tools 自带后两者)。
- 手机/模拟器连 `adb`。

## 3. 最基本用法(只改 host)

```bash
client/repack-app.sh 你的Claude.apks cc.example.com ./out
adb install-multiple ./out/*.apk
```
服务器用公网真域名证书(`scripts/gen-ca.sh 你的域名`,或你自己的证书)时,到这一步就够了——系统信任链本来就认得真域名证书,不需要额外的 CA 注入。

## 4. 可选:配置推送通知(FCM)

需要自己申请一个 Firebase 项目,完整步骤见 [`docs/fcm-setup.md`](./fcm-setup.md)。拿到三元组后:
```bash
CC_FIREBASE_APP_ID="1:xxxx:android:xxxx" \
CC_FIREBASE_PROJECT_ID="你的项目id" \
CC_FIREBASE_API_KEY="AIzaSy..." \
client/repack-app.sh 你的Claude.apks cc.example.com ./out
```
三个变量必须一起给,不给就整个跳过(App 没有推送通知,其它功能不受影响)。

## 5. 可选:信任自签证书

服务器没用公网真域名证书、用的是 `scripts/gen-ca.sh` 生成的自签 CA 时需要这步:
```bash
CC_CA=config/ca.pem client/repack-app.sh 你的Claude.apks cc.example.com ./out
```
这会让 apktool 切到完整反编译(连资源一起解码),比默认模式慢一些,是正常现象。

以上几个选项可以自由组合(比如同时给 `CC_FIREBASE_*` 和 `CC_CA`)。

## 6. 安装到手机

```bash
adb install-multiple ./out/*.apk
```
`install-multiple` 是必须的——这组 APK 是 base + 拆分包,不能单独装某一个。

## 7. 已知问题

早期版本做过一个"登录成功后弹回登录页"的修复(针对 `w95` 这个类)。重新核实过当前版本(26100920)的反编译结果:这个类和官方原始版本相比**没有任何实质性差异**,说明这个问题在当前版本要么已经被 Anthropic 自己修复,要么补丁本身已经不适用于新版本的代码结构——所以本脚本**没有**自动化这部分修复。如果你打完补丁后真的遇到登录成功又弹回登录页的情况,大概率是别的原因(服务端 cookie/session 处理),先检查服务端日志,不要假设是这个历史问题复现。

## 8. 故障排查

- **`Execution failed (exit code = 126)` / "无法执行二进制文件"(仅在用了 `CC_CA` 时出现)**:这是开启 CA 注入后,apktool 需要调用 `aapt2` 重新编译资源,而 `aapt2` 是按 CPU 架构编译的二进制。如果你在 ARM(比如 Apple Silicon 的 Linux 虚拟机、aarch64 服务器)上跑这个脚本,apktool 内置的 `aapt2` 大概率是 x86_64 的,跑不了。解决办法:换一台 x86_64 机器跑这一步(常见的 Linux/Mac/Windows 开发机都是 x86_64,不会遇到这个问题),或者自己装一份匹配当前架构的 `aapt2` 放进 PATH。
- **smali 未找到 `api.anthropic.com`,报错退出**:说明这个版本的 App 结构变了,`OLD_HOST` 默认值对不上,需要自己排查实际用的域名字符串。
- **Firebase 替换提示"未找到,跳过"**:同理,这个版本的原始 Firebase 三元组可能不是脚本内置的默认值,用 `OLD_FIREBASE_APP_ID_PROD` 等同名变量自己指定。
- **`network_security_config.xml` 结构超出处理范围,报错退出**:说明这个版本的网络安全配置比预期复杂(比如有多条 `domain-config`),需要人工打开反编译产物看一眼实际结构,再决定怎么改。
- **证书固定 / 完整性校验导致握手失败**:改了 host 之后如果 App 连接直接失败(不是证书不信任那种报错),可能是触发了某种客户端完整性校验,这个脚本的改法解决不了,需要进一步逆向。
