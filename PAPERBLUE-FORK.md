# 我们自己维护的 OpenBot 分支

这个仓库是我们自己的 fork（`origin` = `Paper-blue/openbot`），长期分支 `maintenance` = 上游 `main` + 下面这几个补丁。上游仓库是 `upstream`（`nightly-labs/openbot`）。

```sh
git remote -v
# origin    https://github.com/Paper-blue/openbot.git      ← 我们的 fork
# upstream  https://github.com/nightly-labs/openbot.git     ← 上游
```

## 我们带了什么

| 文件 | 行为 | 为什么 | 上游 |
| --- | --- | --- | --- |
| `packages/ui/src/features/account/AppLoadingScreen.tsx` | 加载页默认用 calm 场景（一只毛绒 + 状态文字）；调用方显式传 `scene="pile"` 才用满屏毛绒 | 满屏毛绒是密集图案，用户有密集恐惧症，而 app 没有开关 | 无对应 issue，属定制 |
| `src/main/private-network-chromium-features.ts`、`src/main/index.ts` | `private` 路由下给主机加 `--disable-features=…,WebRtcHideLocalIpsWithMdns` | 浏览器把主机 IP 藏成 mDNS `.local` 名字，而 `.local` 只在本地链路可解析，tailnet 上的设备因此没有候选可用，连接 35 秒超时 | [#12587](https://github.com/nightly-labs/openbot/issues/12587) |

**故意没带**：「能力协商没完成就说连接不支持导入助手」的修复（上游 [#12588](https://github.com/nightly-labs/openbot/issues/12588)）。上文那个补丁让协商在 3–4 秒内完成，实际使用已经够；等上游修好再决定要不要自己带一份。

## 定期合并上游

```sh
scripts/paperblue-sync.sh --plan     # 先看要做什么，不改动任何东西
scripts/paperblue-sync.sh            # fetch + merge upstream/main + 装依赖 + 构建
OPENBOT_SKIP_BUILD=1 scripts/paperblue-sync.sh   # 只合并，不构建
```

脚本会检查工作区是否干净、是否在 `maintenance` 分支，然后 `git merge --no-ff upstream/main`。冲突时它会打印每个补丁点的位置；处理原则是**以上游实现为底，把我们的行为重新加回去**，两个补丁都只有几行。

手工等价流程：

```sh
git fetch upstream --prune
git switch maintenance
git merge --no-ff upstream/main
bun install --frozen-lockfile     # 只有 bun.lock 变动时才需要
bun run package
```

## 构建

`bun run package` = `electron-vite build` + `electron-builder --dir --mac --config.mac.identity=null --config.mac.notarize=false`，产出**未公证**的 `dist/mac-arm64/OpenBot.app`（约 610 MB）。

这台机器上实际踩到的四个坑：

1. **工作副本是稀疏检出的**，`apps/`、`remote/` 等目录不在工作区，`bun install` 会报 `Workspace not found "remote/api"`。先 `git sparse-checkout disable`。
2. **Electron 二进制下载要代理**。`bun install` 的 postinstall 直接连 GitHub 会卡住；用 `HTTP_PROXY`/`HTTPS_PROXY` 指向本机代理重跑 `bun run postinstall` 能过（脚本会把 Electron 缓存到 `~/Library/Caches/OpenBot/electron-dist`）。
3. `dist/` 如果残留了缺执行位的目录（`drw-r--r--`），打包会 `EACCES: mkdir dist/mac-arm64.tmp`。`chmod 755 dist` 或删掉重来。
4. `--config.mac.identity=null` 产出的是 ad-hoc 签名，不是 Apple 公证版本。本机运行没问题，但**不能用来发布**，也别指望应用内自动更新。

## 用我们自己的 Developer ID 签名与公证

这台机器上有 `Developer ID Application: InfoAuto, LLC (2U8YUANQ8T)`（keychain 里 SHA-1 `C903755C…`），所以自建包可以签成正规的 Developer ID 版本，不必停在 ad-hoc。

**签不过去的原因**：上游 `build/entitlements.mac.plist` 带两条属于上游团队的限制性权限——`com.apple.developer.team-identifier` = `ZTRDTUL87R`、`com.apple.developer.associated-domains` = `applinks:openbot.run`。换我们的证书保留它们，内核会拒绝启动（"Code has restricted entitlements"）。所以另存了 `build/entitlements.mac.paperblue.plist`，只保留 JIT、未签名可执行内存、麦克风、Apple Events。代价是 `openbot.run` 的网页深链不会打开我们这个构建（域名那边的 apple-app-site-association 认的是上游团队），`openbot://` 自定义 scheme 不受影响。

构建命令（identity 名**不要**带 `Developer ID Application:` 前缀，否则 electron-builder 报错）：

```sh
bun run build
bunx electron-builder --dir --mac \
  --config.mac.identity="InfoAuto, LLC (2U8YUANQ8T)" \
  --config.mac.entitlements=build/entitlements.mac.paperblue.plist \
  --config.mac.entitlementsInherit=build/entitlements.mac.inherit.plist \
  --config.mac.notarize=false      # 公证见下
```

签名完成后应该是：

```
Authority=Developer ID Application: InfoAuto, LLC (2U8YUANQ8T)
TeamIdentifier=2U8YUANQ8T
flags=0x10000(runtime)
codesign --verify --deep --strict  → 0
```

### 公证

一键脚本：`scripts/paperblue-notarize.sh`（构建 → 签名 → 送公证 → 装订 → `spctl` 检查）。它读一个 keychain profile，用前先建一次：

```sh
xcrun notarytool store-credentials openbot-notary \
  --key ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
  --key-id <KEYID> --issuer <ISSUER-UUID>
```

Key ID 就是 `.p8` 文件名里的那串；Issuer ID 在 App Store Connect › Users and Access › Integrations 里。也可以用环境变量代替 profile：`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`，或 `APPLE_KEYCHAIN_PROFILE` 指定 profile 名。

**已知阻塞**：如果团队的 Apple Developer 法律协议没签或已过期，`notarytool` 会在校验凭据这一步直接回 `HTTP 403 A required agreement is missing or has expired`。这不是 key 的问题（换另一把 key 一样报），要账号持有人去 [App Store Connect › 商务](https://appstoreconnect.apple.com) › 协议、税务和银行业务 里把待签协议接受掉，然后再建 profile。

### 换成我们的签名之后

- 屏幕录制、辅助功能这些 TCC 授权会因为我们换了签名身份而需要重新批准一次。
- 应用内自动更新只会接受**我们团队**签的包，官方发布包不会自动覆盖上来。想更新就 `scripts/paperblue-sync.sh` 重新构建。

## 验收

构建后至少过一遍：

1. 新的 `OpenBot.app` 能启动，仓库、对话、provider 正常。
2. 切换服务器时，加载页是一只毛绒 + 状态文字，不是满屏毛绒。可以不用眼睛验：

   ```sh
   dist/mac-arm64/OpenBot.app/Contents/MacOS/OpenBot \
     --user-data-dir=/tmp/ob-check --remote-debugging-port=9333 &
   # 启动后立刻读页面状态：scene 应为 "thinking"，app-loading-plush 数量应为 0
   ```

   用 DevTools 协议对 `main.app-loading` 读 `dataset.scene` 与 `.app-loading-plush` 的数量即可，实测输出是 `{"scene":"thinking","phase":"loading","plushes":0,"status":true}`。
3. 主机切到 `private` 路由后，客户端能在几秒内连上（`compatibility` 阶段 3–4 秒），不再 30 秒超时。
4. 「导入助手」能弹出文件选择框。

## 部署与回退

- 安装：把构建产物替换掉 `/Applications/OpenBot.app`，**先备份现用的包**。
- 回退：换回备份的 `.app`；代码层面 `git revert <commit>` 即可单独撤掉某个补丁。

## 暂时不构建时的替代做法

如果只想用官方发布包，不自己构建：

- 加载页：`2611-开源grok-bot/tools/openbot-calm-loading.py` 给已安装的 `app.asar` 打补丁（改完要更新 asar 头部与 Info.plist 两处哈希并重签名，脚本已处理）。
- 私有路由：在主机 `/opt/OpenBot/hosted/openbot-hosted-server` 的启动行加 `--disable-features=WebRtcHideLocalIpsWithMdns`。
- 这两处都会在 OpenBot 升级时被覆盖，需要重跑。

## 本 fork 自己的更新来源

- `electron-builder.yml` 的 `publish` 指向 `Paper-blue/openbot`，所以这里构建出的桌面应用读的是本仓库的 release，不是上游的。
- `scripts/hosting/openbot-hosted-update` 的 `RELEASES` 也指向本仓库；尚需验证托管服务更新。
- 该更新脚本只接受 `X.Y.Z` 形式、不带预发布后缀的版本号，并要求产物名为 `OpenBot-$version-$architecture.AppImage`，版本和产物名对不上会直接拒绝。

## 自动化

| workflow | 触发 | 做什么 |
| --- | --- | --- |
| `ci.yml` | push / PR 到 `main`、`maintenance` | 原有的检查；`deploy-production` 加了仓库判断，只在上游仓库跑 |
| `fork-upstream-sync.yml` | 每天 03:17 与手动 | 把上游 `main` 合并到 `maintenance`，开 PR 并打 `automerge`；有冲突就不猜，开 issue |
| `fork-merge-gate.yml` | PR | 等 Codex 审完当前提交且没有未解决意见，再开启自动合并 |
| `fork-release.yml` | PR / 标签 / 手动 | 构建个人使用的 macOS、Windows 和 Linux 产物；发布默认关闭，等待验证 |

自动审查、合并及更新流程尚未端到端验证。个人构建不需要 Developer ID 或 Apple 公证；macOS 原生自动更新需要签名，因此不能因为产物构建成功就声称自动更新可用。详细状态见 `docs/fork-automation.md`。

`.yamllint.yml` 声明了本仓库真实的 YAML 约定：继承来的 workflow 行宽远超 yamllint 默认的 80 列，且 `on:` 是 GitHub Actions 的键而不是布尔值。

## 私有路由这一处改动的验证方式

`private-network-chromium-features.ts` 只按路由偏好决定 Chromium 开关。仓库规则是不加单测，只写 E2E；之前的真实远程连接验证仅覆盖已有环境，尚需在后续发布版本中复验。
