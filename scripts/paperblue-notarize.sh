#!/usr/bin/env bash
# Build a signed macOS app from this branch, notarize it, staple the ticket, and check the result.
#
#   scripts/paperblue-notarize.sh            keychain profile "openbot-notary"
#   OPENBOT_NOTARY_PROFILE=other scripts/paperblue-notarize.sh
#   OPENBOT_SIGN_IDENTITY="Name (TEAMID)" scripts/paperblue-notarize.sh
#
# The keychain profile is made once with:
#   xcrun notarytool store-credentials openbot-notary \
#     --key ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
#     --key-id <KEYID> --issuer <ISSUER-UUID>
# A team whose Apple Developer agreement is unsigned or expired gets HTTP 403 from the store step.
set -euo pipefail

app="dist/mac-arm64/OpenBot.app"
identity="${OPENBOT_SIGN_IDENTITY:-InfoAuto, LLC (2U8YUANQ8T)}"
profile="${OPENBOT_NOTARY_PROFILE:-openbot-notary}"
zip="/tmp/openbot-notarize-$(date +%Y%m%d-%H%M%S).zip"

step() { printf '\n== %s\n' "$1"; }

step "构建并签名"
bun run build
bunx electron-builder --dir --mac \
  --config.mac.identity="$identity" \
  --config.mac.entitlements=build/entitlements.mac.paperblue.plist \
  --config.mac.entitlementsInherit=build/entitlements.mac.inherit.plist \
  --config.mac.notarize=false
codesign --verify --deep --strict "$app"
codesign -dv --verbose=2 "$app" 2>&1 | grep -E "Authority|TeamIdentifier|flags"

step "打包成 zip 送公证"
ditto -c -k --keepParent "$app" "$zip"
xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait

step "装订票据"
xcrun stapler staple "$app"
xcrun stapler validate "$app"

step "系统检查"
spctl -a -vvv -t exec "$app"
rm -f "$zip"

cat <<'EOF'

如果 spctl 输出 source=Notarized Developer ID，这个包就能拷给别人直接打开。
EOF
