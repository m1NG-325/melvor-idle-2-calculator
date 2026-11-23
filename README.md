# Melvor Idle 2 Calculator · 梅尔沃放置 2 计算器

[Download / 下载](https://github.com/m1NG-325/melvor-idle-2-calculator/releases/latest)

## Standalone web preview / 独立网页版预览

[Open the web calculator / 打开网页版](https://melvor2calc.pages.dev/)

The static web build is in `web/dist`. Open the preview on desktop or mobile and choose or drop a `.sav` file. The browser reads the save in memory and runs all seven tools locally. Only the language, theme and last tab are stored in the browser. English is the default, with Simplified and Traditional Chinese available in the language menu.

静态网页输出在 `web/dist`。电脑或手机打开预览后可选择或拖入 `.sav`。存档在浏览器内存中解析，七个板块都在浏览器内计算。浏览器只保存语言、配色和最后打开的板块。默认英文，可切换简体中文和繁體中文。

On Windows, expand **Windows save location** to copy the game directory. Paste it into the file picker address bar, then look in `saves` or under `steam` for your account’s `saves` folder. The file picker determines its starting folder.

在 Windows 上可展开「Windows 存档位置」复制游戏目录，粘贴到文件选择窗口的地址栏，再进入 `saves` 或 `steam` 下对应账号的 `saves` 文件夹。选档窗口的起始目录由浏览器决定。

After the game saves again, use **Reload Save** and choose the updated `.sav`, or drop the file onto the page. The calculator updates the role data in the current tab and shows the file’s modification time.

游戏再次保存后，点击「重新读取存档」并选择更新后的 `.sav`，也可以再拖入该文件。计算器会在当前板块更新角色数据，并显示存档文件的修改时间。

```powershell
npm --prefix web ci
npm --prefix web run build -- 'F:\SteamLibrary\steamapps\common\Melvor Idle 2'
npm --prefix web run preview
# Same Wi-Fi / 同一 Wi-Fi
npm --prefix web run preview -- --lan
```

Node.js is used on the machine that builds or serves the preview. Open `http://127.0.0.1:4173/` on that computer, or use the printed LAN address on a phone on the same Wi-Fi. The built files also work on an ordinary static HTTP server with the `.wasm` MIME type set to `application/wasm`.

Node.js 仅用于构建或启动预览的电脑。电脑打开 `http://127.0.0.1:4173/`，同一 Wi-Fi 的手机打开终端显示的局域网地址。也可用普通静态 HTTP 服务提供构建目录，`.wasm` 的 MIME 类型设为 `application/wasm`。

The first preview uses Melvor Idle 2 Early Access Steam build **26724394**. At build time, the calculator extracts the game and shop catalogs and names from the installed game using the desktop readers. After a game update, rebuild with the updated game folder and refresh the page. The save reader currently supports save format **31**. A format change requires updating the shared parser and rechecking both editions.

首版预览使用《梅尔沃放置 2》抢先体验版 Steam 构建 **26724394**。构建时沿用本地版的数据读取逻辑，从已安装游戏提取计算目录、商店目录和名称。游戏更新后，指向更新后的游戏目录重新构建，再刷新网页。当前支持存档格式 **31**。若格式升级，需更新共用解析器并重新核对两版结果。

To repeat the browser comparison, run `node web/node_modules/playwright-core/cli.js install chromium --only-shell`, then `npm --prefix web run verify -- 'PATH_TO_GAME_DIRECTORY'`. It uses the newest save discovered by the desktop edition by default. An optional second path selects a different save discoverable by the desktop edition.

复测时先运行 `node web/node_modules/playwright-core/cli.js install chromium --only-shell`，再运行 `npm --prefix web run verify -- '游戏安装目录'`。默认使用本地版找到的最新存档，也可在游戏目录后指定另一份本地版能找到的存档。

### Optional accounts / 可选账号

The account preview runs on Cloudflare Pages Functions and a separate D1 database. Guests can use all seven tools. Signed-in users can save named training plans, production plans and snapshots. A snapshot sends only the selected categories: skill levels, bank inventory or totals from Statistics. Raw saves stay in the browser. Email verification and password recovery are currently absent.

账号预览使用 Cloudflare Pages Functions 和独立 D1 数据库。游客可以使用全部七个板块。登录后可按名称保存练级计划、产线方案和角色快照。快照仅同步主动勾选的技能等级、仓库库存或统计汇总。原始存档留在浏览器中。当前版本尚未接入邮箱验证和密码找回。

Run the following in `web` after building. Put `AUTH_URL=http://127.0.0.1:4174` and `BETTER_AUTH_SECRET=<random secret of at least 32 characters>` in the ignored `.dev.vars` file. The browser test creates accounts only in the local database.

构建后，在 `web` 下的 `.dev.vars` 中设置 `AUTH_URL=http://127.0.0.1:4174` 和 `BETTER_AUTH_SECRET=<至少 32 字符的随机密钥>`，再运行以下命令。浏览器测试只在本地数据库注册测试账号。

```powershell
npx wrangler d1 migrations apply CALCULATOR_DB --local
npm run preview:accounts
# Run in a second terminal / 在另一个终端运行
npm run verify:accounts
```

The public site uses the `melvor2calc` Pages project and its separate `melvor2calc-accounts` D1 database. Production bindings are in `web/wrangler.jsonc` under `env.production`. The authentication secret is stored in Cloudflare Pages. After rebuilding, deploy from `web` with `npx wrangler pages deploy dist --project-name melvor2calc --branch main` to publish the frontend and Pages Functions together. If a release adds a database migration, apply it first with `npx wrangler d1 migrations apply CALCULATOR_DB --env production --remote`.

正式站使用 `melvor2calc` Pages 项目和独立的 `melvor2calc-accounts` D1 数据库。生产绑定在 `web/wrangler.jsonc` 的 `env.production` 下，认证密钥存放在 Cloudflare Pages。重新构建后，在 `web` 目录运行 `npx wrangler pages deploy dist --project-name melvor2calc --branch main`，一并发布前端和 Pages Functions。如果版本新增了数据库迁移，先运行 `npx wrangler d1 migrations apply CALCULATOR_DB --env production --remote`。

## 简体中文

读取本机存档，比较挂机和连锁产线的金币收益，查看战斗收益、练级方案和目标等级所需时间。任务和商店升级缺材料时，也能查去哪拿、多久能凑齐。

1. 在 Windows 上安装 Node.js，解压 ZIP，双击 `Start-GP-Calculator.cmd`。
2. 找不到游戏时，把含有 `Melvor2.exe` 的文件夹拖到启动器上。
3. 在网页左侧选角色，右上角可切换 English、简体中文和繁體中文。

有新版时，点侧栏的「下载并更新」，原来的设置会保留。

「定时挂机」可保存多个队列。步骤可设为无时限、按时长、按配方完成次数、按产品获得量或持有量、按材料消耗量或剩余量，以及按目标技能等级。Windows 桌面版执行队列时直接链接已安装的游戏文件。无法创建硬链接时会尝试符号链接，Windows 可能要求开发人员模式。

桌面发布包应包含 `vendor/calculator-queue-bridge.json` 和 `vendor/game-names-zh.json`。前者随桥接程序集重新生成。发布 ZIP 使用桥接 JSON，让 0.3.0 到 0.4.1 的网页更新器也能解包。

## English

Use your local save to compare GP from idle actions and production chains, estimate combat gains, and find training plans and times to reach your target levels. Check where to get missing materials for quests and shop upgrades.

1. Install Node.js on Windows, extract the ZIP, and run `Start-GP-Calculator.cmd`.
2. If the game isn't found, drag the folder containing `Melvor2.exe` onto the launcher.
3. Pick a character in the sidebar and switch languages in the top right.

When an update is available, click **Download and Update** in the sidebar. Your settings carry over.

**Timed Action Queue** can save multiple queues. Steps can run without a time limit or end after a duration, a recipe count, a product gain or stock target, a material spending or remaining-stock target, or a skill level. The Windows desktop app links to installed game files. It tries symbolic links when hard links are unavailable. Windows may require Developer Mode.

Desktop releases include `vendor/calculator-queue-bridge.json` and `vendor/game-names-zh.json`. Regenerate the bridge JSON when rebuilding the assembly. Use the JSON bridge in the release ZIP for compatibility with the web updaters in versions 0.3.0 through 0.4.1.

Traditional Chinese conversion runs offline with [OpenCC JS](https://github.com/nk2028/opencc-js).
