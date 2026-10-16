#!/usr/bin/env bash
# repack-app.sh — 把官方 Claude Android App 指向你的自部署 claude_cloud-ce 服务器,
# 可选换掉内置的 FCM 推送目标、可选注入自签 CA 信任。
#
# 基本流程:解包 .apks → 把 dex 里的 api.anthropic.com 换成你的 HOST → 重打包 base.apk
#   → 用同一把本地 key 给 base + 所有 split 重签名 → 产出可 install-multiple 的一组 apk。
# host 只在 base.apk 的 dex 里(资源无),所以默认只反汇编 dex(-r 保留资源),重打包更稳;
# 开启 CA 注入时才会切到完整反编译(见下)。
#
# 用法(最基本,只改 host,向后完全兼容):
#   repack-app.sh <Claude.apks | 含apk的目录> <新HOST> [输出目录]
# 例:
#   repack-app.sh app_temp_work/Claude_1.260721.20.apks cc.example.com ./out
#
# 环境变量(全部可选,不给就是现在这个基本用法):
#   OLD_HOST  被替换的 host(默认 api.anthropic.com)
#   CC_KEYSTORE / CC_KEYSTORE_PASS  签名库(默认 ~/.config/cc-cloud/app-sign.jks / cccloud,缺则自动生成)
#   APKTOOL / APKSIGNER  覆盖工具命令
#
#   CC_FIREBASE_APP_ID / CC_FIREBASE_PROJECT_ID / CC_FIREBASE_API_KEY
#       换掉 App 内置的 Firebase 推送目标,换成你自己申请的项目(三个必须一起给,
#       申请步骤见 docs/fcm-setup.md)。不给就跳过,App 没有推送通知,其它功能不受影响。
#       旧值(官方版本的原始 Firebase 三元组,Production/Staging 各一套)有内置默认,
#       遇到不同 App 版本、默认值对不上时可以用 OLD_FIREBASE_APP_ID_PROD 等同名变量覆盖。
#
#   CC_CA   自签 CA 证书路径(.pem,和 client/connect.sh、client/worker.sh 的 CC_CA 同一个东西)。
#       给了才会把 App 的 network-security-config 改成信任这张 CA,同时把反编译切到完整模式
#       (连资源一起解码,比默认的"只反汇编 dex"慢,但 CA 注入必须这样做)。服务器用公网真
#       域名证书时不需要这个,直接用系统信任链即可,不用设 CC_CA。
#
# 前提:apktool、apksigner、keytool、unzip。aarch64 无原生 zipalign 可忽略(base 无 native lib)。
#
# ⚠ 两点现实:
#   1) 若存在证书固定/完整性校验,改 host 后可能握手失败——真挂了再定位。
#   2) 网络安全配置这块只处理"没有该文件"和"已有 base-config"这两种常见形状;如果原
#      APK 的 network_security_config.xml 只有复杂的 domain-config 结构,脚本会报错退出、
#      提示人工处理,不会猜测着生成一份可能有安全隐患的配置。
set -euo pipefail

SRC="${1:?用法: repack-app.sh <.apks|apk目录> <新HOST> [输出目录]}"
NEW_HOST="${2:?需要新 HOST,例如 cc.example.com}"
OUT="${3:-$PWD/repack-out}"
OLD_HOST="${OLD_HOST:-api.anthropic.com}"
APKTOOL="${APKTOOL:-apktool}"
APKSIGNER="${APKSIGNER:-apksigner}"
KS="${CC_KEYSTORE:-$HOME/.config/cc-cloud/app-sign.jks}"
KSPASS="${CC_KEYSTORE_PASS:-cccloud}"

command -v "$APKTOOL"   >/dev/null || { echo "缺 apktool";   exit 1; }
command -v "$APKSIGNER" >/dev/null || { echo "缺 apksigner"; exit 1; }

WORK="$(mktemp -d /tmp/repack-app.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "[*] 工作目录 $WORK"

# 1) 收集 apk(.apks 解压,或目录直接拷)
mkdir -p "$WORK/apks"
if [ -d "$SRC" ]; then cp "$SRC"/*.apk "$WORK/apks/"; else unzip -o -q "$SRC" -d "$WORK/apks"; fi
ls "$WORK/apks"/*.apk >/dev/null 2>&1 || { echo "没找到 apk"; exit 1; }
echo "[*] 拿到: $(cd "$WORK/apks" && ls *.apk | tr '\n' ' ')"

# 2) 找出带 dex 的 base apk(改 host/Firebase 都要动它的 smali);split/config 包只重签。
#    不假设文件名一定叫 base.apk——不同来源的 .apks(bundletool 标准产物 vs 设备直接
#    导出的工具)对这个文件的命名约定不一样,用"含不含 classes.dex"判断更可靠。
BASE=""
for f in "$WORK/apks"/*.apk; do
  # 注意:不能写成 `unzip -l "$f" | grep -q ...`——set -o pipefail 下 grep -q 一命中就
  # 提前退出,会让上游 unzip 因 SIGPIPE 非零退出,被 pipefail 当成整个管道失败,误判。
  # 先把完整输出存进变量,再用 bash 内置的正则匹配(纯内存操作,不经子进程/管道)。
  listing="$(unzip -l "$f" 2>/dev/null || true)"
  if [[ "$listing" =~ classes.*\.dex ]]; then
    [ -z "$BASE" ] || { echo "⚠ 找到不止一个含 dex 的 apk($BASE 和 $f),这个版本结构超出预期,需要人工确认"; exit 1; }
    BASE="$f"
  fi
done
[ -n "$BASE" ] || { echo "缺 base apk(没有任何 apk 含 classes.dex)"; exit 1; }
echo "[*] base apk: $(basename "$BASE")"

# CA 注入要改 res/xml/network_security_config.xml(编译后的二进制 XML),必须让 apktool
# 连资源一起解码;不注入 CA 时维持原来的"只反汇编 dex"(-r),更快更稳。
if [ -n "${CC_CA:-}" ]; then
  echo "[*] 反编译 base.apk(含资源,CA 注入需要)…"
  "$APKTOOL" d -f -o "$WORK/base_src" "$BASE"
else
  echo "[*] 反汇编 base.apk 的 dex(保留资源)…"
  "$APKTOOL" d -r -f -o "$WORK/base_src" "$BASE"
fi

hits=$(grep -rl "$OLD_HOST" "$WORK/base_src"/smali* 2>/dev/null | wc -l)
echo "[*] smali 内含 $OLD_HOST 的文件数:$hits"
[ "$hits" -gt 0 ] || { echo "⚠ smali 未找到 $OLD_HOST,该版本结构可能变了"; exit 1; }
echo "[*] 替换主机名 $OLD_HOST -> $NEW_HOST(只动作为独立主机名出现处,避开 a-api/a-cdn 等前缀子域)"
grep -rl "$OLD_HOST" "$WORK/base_src"/smali* | while IFS= read -r f; do
  sed -i "s#\\([\"/]\\)${OLD_HOST//./\\.}#\\1${NEW_HOST}#g" "$f"
done

# ── Firebase 三元组替换(可选,三个变量必须一起给)──────────────────────
FB_NEW_APP_ID="${CC_FIREBASE_APP_ID:-}"
FB_NEW_PROJECT_ID="${CC_FIREBASE_PROJECT_ID:-}"
FB_NEW_API_KEY="${CC_FIREBASE_API_KEY:-}"
if [ -n "$FB_NEW_APP_ID$FB_NEW_PROJECT_ID$FB_NEW_API_KEY" ]; then
  if [ -z "$FB_NEW_APP_ID" ] || [ -z "$FB_NEW_PROJECT_ID" ] || [ -z "$FB_NEW_API_KEY" ]; then
    echo "⚠ CC_FIREBASE_APP_ID / CC_FIREBASE_PROJECT_ID / CC_FIREBASE_API_KEY 必须三个一起给,不能只给一部分(半新半旧会导致 App 初始化崩溃)"
    exit 1
  fi
  # 官方 26100920 版本反编译取证得到的原始值:Production 和 Staging 实际是两个不同的
  # Firebase 项目,这里都替换成你提供的同一个新项目(你通常只有一个 Firebase 项目)。
  OLD_FB_APP_ID_PROD="${OLD_FIREBASE_APP_ID_PROD:-1:365066964946:android:74b043cc0229679ab8420b}"
  OLD_FB_PROJECT_ID_PROD="${OLD_FIREBASE_PROJECT_ID_PROD:-proj-scandium-production-5zhm}"
  OLD_FB_API_KEY_PROD="${OLD_FIREBASE_API_KEY_PROD:-AIzaSyDUHK0y-xkW5lwNiHodVVZ9Wl5YC7_TxkY}"
  OLD_FB_APP_ID_STAGING="${OLD_FIREBASE_APP_ID_STAGING:-1:90987362560:android:7e0746cc4a44a327589be5}"
  OLD_FB_PROJECT_ID_STAGING="${OLD_FIREBASE_PROJECT_ID_STAGING:-proj-scandium-staging-n35i}"
  OLD_FB_API_KEY_STAGING="${OLD_FIREBASE_API_KEY_STAGING:-AIzaSyBHforeFMPxWZg51b3HRS3-nHUIfUfNSso}"

  fb_replace() {
    local old="$1" new="$2" files
    files=$(grep -rl -- "$old" "$WORK/base_src"/smali* 2>/dev/null || true)
    if [ -z "$files" ]; then echo "    (未找到 $old,跳过——这个版本可能不是内置默认值,可用 OLD_FIREBASE_* 自己指定)"; return; fi
    echo "$files" | while IFS= read -r f; do sed -i "s#${old}#${new}#g" "$f"; done
  }
  echo "[*] 替换 Firebase 三元组(Production + Staging 都换成你的新项目)…"
  fb_replace "$OLD_FB_APP_ID_PROD" "$FB_NEW_APP_ID"
  fb_replace "$OLD_FB_PROJECT_ID_PROD" "$FB_NEW_PROJECT_ID"
  fb_replace "$OLD_FB_API_KEY_PROD" "$FB_NEW_API_KEY"
  fb_replace "$OLD_FB_APP_ID_STAGING" "$FB_NEW_APP_ID"
  fb_replace "$OLD_FB_PROJECT_ID_STAGING" "$FB_NEW_PROJECT_ID"
  fb_replace "$OLD_FB_API_KEY_STAGING" "$FB_NEW_API_KEY"
else
  echo "[*] 未设置 CC_FIREBASE_*,跳过 Firebase 替换(App 不会有推送通知,其它功能不受影响)"
fi

# ── TLS/CA 信任注入(可选)────────────────────────────────────────────
if [ -n "${CC_CA:-}" ]; then
  [ -f "$CC_CA" ] || { echo "⚠ CC_CA 指的文件不存在:$CC_CA"; exit 1; }
  NSC="$WORK/base_src/res/xml/network_security_config.xml"
  MANIFEST="$WORK/base_src/AndroidManifest.xml"
  if [ ! -f "$NSC" ]; then
    echo "[*] 原 APK 没有 network_security_config.xml,新建一份"
    mkdir -p "$(dirname "$NSC")"
    cat > "$NSC" <<'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/cc_ca" />
        </trust-anchors>
    </base-config>
</network-security-config>
XMLEOF
    if [ -f "$MANIFEST" ] && ! grep -q 'android:networkSecurityConfig' "$MANIFEST"; then
      echo "[*] manifest 未引用 networkSecurityConfig,插入该属性"
      sed -i 's#<application #<application android:networkSecurityConfig="@xml/network_security_config" #' "$MANIFEST"
    fi
  else
    # 自闭合的 <base-config .../> 先规整成 <base-config ...></base-config>,方便后面统一处理
    if grep -qE '<base-config[^>]*/>' "$NSC"; then
      sed -i -E 's#<base-config([^>]*)/>#<base-config\1></base-config>#' "$NSC"
    fi
    if grep -q '<trust-anchors>' "$NSC"; then
      echo "[*] 已有 trust-anchors,追加自签 CA 信任锚(不删除原有的 system 信任锚)"
      sed -i '/<trust-anchors>/a\        <certificates src="@raw/cc_ca" />' "$NSC"
    elif grep -q '<base-config' "$NSC"; then
      echo "[*] 已有 base-config 但没有 trust-anchors,插入一个"
      sed -i 's#<base-config\([^>]*\)>#<base-config\1><trust-anchors><certificates src="system" /><certificates src="@raw/cc_ca" /></trust-anchors>#' "$NSC"
    else
      echo "⚠ network_security_config.xml 结构超出本脚本能安全处理的范围(可能只有 domain-config,没有 base-config),需要人工处理,内容如下:"
      cat "$NSC"
      exit 1
    fi
    sed -i 's/cleartextTrafficPermitted="false"/cleartextTrafficPermitted="true"/' "$NSC"
    grep -q 'cleartextTrafficPermitted' "$NSC" || sed -i 's#<base-config#<base-config cleartextTrafficPermitted="true"#' "$NSC"
  fi
  mkdir -p "$(dirname "$WORK/base_src/res/raw/cc_ca.pem")"
  cp "$CC_CA" "$WORK/base_src/res/raw/cc_ca.pem"
  echo "[*] 已把 $CC_CA 塞进 res/raw/cc_ca.pem 并写入信任锚"
else
  echo "[*] 未设置 CC_CA,跳过证书信任注入(服务器用公网真域名证书时不需要这步)"
fi

# apktool 的 wrapper 默认堆仅 256M,汇编大 app 的多个 dex 会 OOM;加大堆 + 串行(省内存)
echo "[*] 重打包 base.apk(堆 ${APKTOOL_HEAP:-1024m} / jobs ${APKTOOL_JOBS:-1})…"
"$APKTOOL" -JXmx"${APKTOOL_HEAP:-1024m}" b -j "${APKTOOL_JOBS:-1}" -o "$WORK/base-new.apk" "$WORK/base_src"
cp -f "$WORK/base-new.apk" "$BASE"

# 3) 签名库(缺则生成)
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  echo "[*] 生成签名库 $KS"
  keytool -genkeypair -keystore "$KS" -storepass "$KSPASS" -keypass "$KSPASS" \
    -alias cc -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=cc-cloud app signer, O=cc-cloud, C=US"
fi

# 4) 同一把 key 给整组 apk 重签(install-multiple 要求签名一致)
mkdir -p "$OUT"; rm -f "$OUT"/*.apk "$OUT"/*.idsig
for apk in "$WORK/apks"/*.apk; do
  n="$(basename "$apk")"; cp -f "$apk" "$OUT/$n"
  "$APKSIGNER" sign --ks "$KS" --ks-pass "pass:$KSPASS" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true "$OUT/$n"
  rm -f "$OUT/$n.idsig"
done

echo
echo "[✓] 完成,产物在:$OUT"
echo "    设备 adb 连好后安装:"
printf '    adb install-multiple'; for a in "$OUT"/*.apk; do printf ' %s' "$a"; done; echo
