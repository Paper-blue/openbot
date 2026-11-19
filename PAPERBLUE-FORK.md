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
