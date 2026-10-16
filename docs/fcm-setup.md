# 配置 FCM 推送通知(可选)

官方 Claude App 完成一轮回复后,如果你当时不在前台,可以收到一条系统推送——这个功能完全可选,不配置不影响核心的"官方 App 连自建服务器"能力,正常聊天、生成会话、分享链接等全部照常工作。只有想要后台推送通知时才需要看这篇文档。

推送走 Google 的 FCM(Firebase Cloud Messaging),服务端用你自己的 Firebase 项目发送,App 侧用 [`client/repack-app.sh`](../client/repack-app.sh) 把包里写死的 Firebase 配置换成你自己项目的——两边必须用**同一个** Firebase 项目,否则服务端发的推送 App 收不到。

## 1. 判断要不要配这个

不需要就直接跳过,完全不影响其它功能。需要的话继续往下看。

## 2. 创建 Firebase 项目

1. 打开 [Firebase 控制台](https://console.firebase.google.com/),新建一个项目。
2. 项目名随意;是否开启 Google Analytics 都可以,不需要就关掉能省点设置步骤。

## 3. 注册 Android 应用,拿到客户端三元组

1. 项目总览页点"添加应用" → Android 图标。
2. **包名必须填 `com.anthropic.claude`**——这是官方 App 的真实包名,改不了,也不能填别的,否则生成的配置和 App 实际包名对不上,推送根本收不到。
3. 应用昵称随意,SHA-1 证书指纹可以跳过(不影响 FCM data-only 推送)。
4. 下载生成的 `google-services.json`,打开它,记下三个字段(第 4 节和 `client/repack-app.sh` 都要用):
   - `client/client_info/mobilesdk_app_id` → 对应脚本的 `CC_FIREBASE_APP_ID`
   - `project_info/project_id` → 对应脚本的 `CC_FIREBASE_PROJECT_ID`
   - `client/api_key/current_key` → 对应脚本的 `CC_FIREBASE_API_KEY`

## 4. 生成服务账号私钥(服务端用)

1. Firebase 控制台 → 齿轮图标「项目设置」→「服务账号」标签页。
2. 点「生成新的私钥」,下载 JSON 文件。
3. **这份文件含私钥,等同于账号密码,绝不能提交进任何 git 仓库、绝不能公开分享**——它应该只存在于你自己的服务器磁盘上。

## 5. 接进服务端配置

把下载的服务账号 JSON 放到一个**仓库目录之外**的位置,比如:
```bash
mkdir -p ~/.config/cc-cloud
mv ~/Downloads/你的项目-firebase-adminsdk-xxx.json ~/.config/cc-cloud/firebase-adminsdk.json
```
然后告诉服务端这个路径,二选一:
- 环境变量:`CC_FCM_SA=~/.config/cc-cloud/firebase-adminsdk.json`
- `config/config.json` 里的 `fcmServiceAccountPath` 字段(参考 `config/config.example.json`)

如果不设置,默认就是 `~/.config/cc-cloud/firebase-adminsdk.json`(即 `CC_DATA_DIR` 下),所以按上面的命令放到默认位置的话,其实什么都不用配。

## 6. 接进客户端补丁

用 [`client/repack-app.sh`](../client/repack-app.sh) 打补丁时,加上第 3 节拿到的三元组(三个变量必须一起给):
```bash
CC_FIREBASE_APP_ID="1:xxxx:android:xxxx" \
CC_FIREBASE_PROJECT_ID="你的项目id" \
CC_FIREBASE_API_KEY="AIzaSy..." \
client/repack-app.sh app_temp_work/你的.apks cc.example.com ./out
```
详见 [`docs/repack-app.md`](./repack-app.md)。

## 7. 验证

重启服务端,看启动日志里有没有这一行:
```
[fcm] 推送就绪 project=你的项目id
```
没有这一行(或者看到"服务账号未加载")说明路径没配对,检查第5节的路径。

实测验证:用打好补丁的 App 正常聊天,等一轮回复完成后退到后台,应该能收到系统推送。
