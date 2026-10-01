# 小程序：开发者工具与真机检查

e2e（`pnpm --filter @shop/e2e-storefront test`）跑的是「模拟小程序」H5 构建，看不到 WXML、原生组件、
微信自己的弹窗和真机上的网络限制（[S4 报告](spikes/S4-e2e.md)的「What is and isn't covered」）。
这份清单补上这一块：用店铺已经上线的正式小程序 AppID，把 `dist/weapp` 放进微信开发者工具，再扫码
在 iPhone 和 Android 上各过一遍。

改了手机上会跑到的东西（`src/platform/`、页面首屏、tabBar、登录、支付、装修块）就要过一遍，
并按[第 7 节](#7-回报结果)回报。过不了或没法测的项，照实写「失败」或「未测 + 原因」，
不要写成通过。

## 1. 先读：边界

- **AppID `wx4f4b772125e155ed`** 是店铺已审核上线的小程序，AppID 是公开标识，可以写在文档里，
  也可以作为构建默认值（`scripts/device-build.mjs` 不传 `--appid` 就用它）。仓库里提交的文件只允许出现
  这个 AppID 或 `touristappid`，别人自己的 AppID 放 `apps/mini/.env.*.local`（已 gitignore），
  由 `mini` 守卫的 `[config]` 检查。
- **AppSecret 只存在服务端配置里**：生产服务器，或者你本机后台「小程序」配置分组（`wechat-mini`，
  存在本机数据库）。它不进仓库、不进 `.env*`、不进小程序包。`mini` 守卫的 `[credentials]` 会拦
  `apps/mini` 下任何 32 位十六进制串，`size-report` 会拦 `dist/weapp` 里的同样的串。
  **不要为了测试去公众平台「重置」AppSecret。** 但如果它泄露过（比如贴进过聊天、邮件、截图），就应该重置：
  重置后旧值立即失效，所以要**同时**把新值填进生产后台的配置，否则已上线的登录会断。
- **代码上传密钥（`private.*.key`）放在仓库外**，见[第 8 节](#8-可选用-miniprogram-ci-出预览码或上传)。
- **预览、真机调试、上传都会把代码包送到微信的服务器。** 在开发者工具里点「预览」「真机调试」是你本人的
  操作；让脚本或 agent 去做（miniprogram-ci），每一次都要你本人明确同意。本清单只用「预览」和「真机调试」，
  不点「上传」：上传会在公众平台「版本管理」里生成开发版本，它可以被设为体验版或提交审核，属于发布流程。
- **后端永远是本机的栈**（第 3 节），绝不指向生产 API，也不去动生产主机。

## 2. 一次性准备

### 2.1 加成员

用小程序管理员的微信扫码登录 [公众平台](https://mp.weixin.qq.com)，进入 **管理 → 成员管理**：

- **项目成员 → 添加 → 勾「开发者」权限**：在开发者工具里登录、编译、点「预览」「真机调试」的人。
  没有这个权限，开发者工具会提示「无权限」，用正式 AppID 打开项目也只能进游客模式。
- **体验成员**：只扫码、不操作开发者工具的测试人。扫开发版预览码时如果提示无权限，就把他也加为开发者。

加完后被加的人要在微信里确认邀请。检查结束后不再需要的成员可以在同一处移除。

### 2.2 装工具

- [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)稳定版，
  装在 Windows 上，用 2.1 里的开发者微信扫码登录。
- 测试手机：一台 iPhone、一台 Android，微信都升到最新。记下机型、系统版本、微信版本和基础库版本
  （小程序里 右上角「…」→ 小程序名称 → 可以看到；或在「真机调试」的控制台里看）。

## 3. 选一个后端（都在本机）

| 后端                        | 启动                                                                                                                                   | 能测什么                                                                                                                 | 不能测什么                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 契约 mock 服务器**     | `pnpm --filter @shop/testing mock -- --host 0.0.0.0 --port 4010`                                                                       | 布局、组件、tabBar、装修块、页面跳转、错误态。每个接口按契约示例返回，**不校验登录**，所以静默登录「成功」、各页有数据。 | 真实数据和写入（什么都不落库）；示例里的图片地址多半打不开；支付参数是示例，`requestPayment` 必然失败。                                      |
| **B. e2e 全栈（全是假件）** | `SHOP_E2E_WECHAT_DEVICE=1 pnpm --filter @shop/e2e-storefront serve`（需要 Docker），日志里 `starting edge on :<端口>` 和 `DEVICE MODE` | 真实服务端逻辑和种子数据；加了 `SHOP_E2E_WECHAT_DEVICE=1`（设备模式）后，静默登录和手机号快捷登录也能走通（见下）。      | 真实的微信身份：openid 和手机号都是假件算出来的。支付走假网关，真机上付不了。不加 `SHOP_E2E_WECHAT_DEVICE=1` 时登录回 `40029 invalid code`。 |
| **C. 本地开发栈 + 真登录**  | README「Local development」里的 `pnpm dev`（web 在 `:3000`）                                                                           | 在**本机**后台「小程序」配置里填正式 AppID 和 AppSecret（只存本机数据库），静默登录、手机号快捷登录都是真的。            | 支付（商户号和证书只在生产）。                                                                                                               |

- A 最省事，UI 检查首选。B 用来看真实数据下的页面。C 会从本机访问 `api.weixin.qq.com`，每次启用都先征得
  你本人同意；AppSecret 只能填你已经掌握的那个；何时该重置见第 1 节。手机号快捷登录按次计费。
- B 的 edge 只监听 `127.0.0.1`，手机访问前要在 WSL 里加一个转发（第 4 节）。
- **B 的设备模式**（`SHOP_E2E_WECHAT_DEVICE=1`，只影响本机的假 `api.weixin.qq.com`，默认关闭，e2e 套件从不打开）：
  真机和开发者工具里 `wx.login` 拿到的是微信真实的 code，假件本来不认识它。设备模式下，假件接受任何格式正确的
  code（微信的字符集，16–128 位）：登录 code 按哈希映射成固定的假 openid（`odev_…`），手机号 code 映射成
  `139…` 的假手机号；同一个 code 仍然只能用一次，格式不对的仍回 `40029`。每次冷启动 `wx.login` 的 code 都不同，
  所以默认每次冷启动都是一个新用户；想一直是同一个用户，再加
  `SHOP_E2E_WECHAT_DEVICE_OPENID=odev_tester`（手机号用 `SHOP_E2E_WECHAT_DEVICE_PHONE=13900000001`）。
  这不会访问真实的微信，也不需要 AppSecret。

## 4. 让手机访问本机

手机和电脑连同一个 Wi-Fi。在 Windows 上 `ipconfig` 查到电脑的局域网 IP，下面记作 `<LAN_IP>`
（例如 `192.168.1.20`）。开发者工具和手机都用这个地址，构建里只需要写一个源。

**WSL2 默认的 NAT 网络，局域网访问不到 WSL 里的端口。** 二选一：

- **镜像网络**（Windows 11 22H2 及以上）：在 `%UserProfile%\.wslconfig` 写

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  然后 `wsl --shutdown` 重开，并在 Windows 防火墙放行这个入站端口（见下面的 `New-NetFirewallRule`）。

- **端口转发**：在**管理员** PowerShell 里（`<WSL_IP>` 是 WSL 里 `hostname -I` 的第一个地址，
  每次重启 WSL 可能变）：

  ```powershell
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=4010 connectaddress=<WSL_IP> connectport=4010
  New-NetFirewallRule -DisplayName "shop-dev-4010" -Direction Inbound -Protocol TCP -LocalPort 4010 -Action Allow
  # 用完删掉
  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=4010
  Remove-NetFirewallRule -DisplayName "shop-dev-4010"
  ```

**后端 B 只监听 `127.0.0.1`**：在 WSL 里另开一个终端，把 `0.0.0.0:4010` 转到 edge 的端口（不用装任何东西）：

```sh
EDGE=<edge 端口> node -e "const n=require('net');n.createServer(c=>{const u=n.connect(+process.env.EDGE,'127.0.0.1');c.pipe(u).pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(4010,'0.0.0.0')"
```

后端 C（`next dev`）本身监听所有地址，端口是 3000，把上面的 4010 换成 3000。

**http 局域网地址只能配「开发调试」用。** 真机上打开预览的小程序后，点右上角「…」→「开发调试」→
重启小程序。开发版和体验版这样就不校验合法域名、TLS 和 HTTPS 证书（[C03](wechat-compliance.md)）。
也可以用 HTTPS 隧道（例如 cloudflared 的临时隧道）得到一个 https 地址：它会把本机服务暴露到公网并经过
第三方，用不用由你决定；隧道域名不在公众平台「服务器域名」里，所以手机上还是要开「开发调试」。
**不要为了测试去改公众平台的服务器域名配置**，那是生产配置。

## 5. 构建，在开发者工具里打开

```sh
pnpm --filter @shop/mini exec node scripts/device-build.mjs --origin http://<LAN_IP>:4010
```

脚本（`apps/mini/scripts/device-build.mjs`）会：

- 检查 AppID（默认 `wx4f4b772125e155ed`，可以用 `--appid` 或 `TARO_APP_ID` 换）和 API 源：
  `https://` 随意，`http://` 只允许回环地址和私有局域网地址，只写 `scheme://host:port`，不带路径；
- 用这两个值跑 `taro build --type weapp --no-check`（命令行的环境变量优先于所有 `.env*` 文件，
  不会写进任何文件）；
- 源是 http 时，写 `dist/weapp/project.private.config.json`（`urlCheck: false`），开发者工具打开就不校验域名，
  和「详情 → 本地设置 → 不校验合法域名……」是同一个开关；
- 跑 `size-report`（包体积、ES2018、测试代码、疑似密钥），不通过就停。

不想用脚本也可以把 `TARO_APP_API_ORIGIN=http://<LAN_IP>:4010` 写进 `apps/mini/.env.production.local`
（已 gitignore），跑 `pnpm --filter @shop/mini build:weapp`，再在开发者工具里手动勾「不校验合法域名」。

然后在开发者工具里：

1. **导入项目**，目录选 WSL 里的 `apps/mini/dist/weapp`（在 Windows 里是
   `\\wsl.localhost\<发行版>\home\…\apps\mini\dist\weapp`）。AppID 会从 `project.config.json` 读出
   `wx4f4b772125e155ed`。如果监听 `\\wsl.localhost` 下的文件太慢，可以把 `dist/weapp` 复制到 Windows 目录再导入，
   每次重新构建后重新复制。
2. **模拟器**里先点一遍首页和四个 tab，控制台（Console）没有红色报错、Network 里请求打到 `<LAN_IP>`。
3. **预览**：工具栏「预览」→ 用手机微信扫码，打开的是开发版。要看控制台和网络请求就用「真机调试」。
   两个都会把代码包传到微信服务器生成二维码（第 1 节）。
4. 要从某个页面启动（例如装修块页），在工具栏「编译模式」里「添加编译模式」，启动页面填页面路径；
   预览会用当前的编译模式。

## 6. 检查清单

iPhone 和 Android 各过一遍。每项记「通过 / 失败 / 未测（原因）」。「后端」列是这项至少要哪个后端。
某项依赖的页面或功能还没做（看 `docs/mini/status/`），记「未测：未实现」。

| #   | 项目                 | 怎么做                                                                                           | 期望                                                                                                                                                                                                | 后端   |
| --- | -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D01 | 冷启动               | 从微信里彻底关掉小程序再扫码打开                                                                 | 首页正常出来，不白屏；**启动时不弹任何授权**（手机号、位置、隐私）（C16 3.4.1）                                                                                                                     | A/B/C  |
| D02 | tabBar               | 四个 tab 来回切；加购一件商品后看购物车 tab                                                      | 每个 tab 都有图标（默认一套灰 / 红线形图标，选中的带浅色填充）；文字、颜色、选中色和后台主题一致（运行时设置）；后台上传了 tab 图标就换成上传的，删掉后回到默认图标；购物车角标数字正确，清空后消失 | A/B    |
| D03 | 隐私弹窗             | 第一次触发隐私接口（手机号按钮、选择收货地址）                                                   | 先弹隐私协议，同意后才继续；拒绝后有提示、不卡死（C04）                                                                                                                                             | A/B/C  |
| D04 | 静默登录             | 冷启动；「真机调试」里看 Network                                                                 | 没有登录弹窗；有一次 `POST /api/v1/auth/sessions/wechat-mini`；热启动（切后台再回来）不再调用。后端 B 不开设备模式时这里失败（40029）是预期，记下来即可                                             | A/B/C  |
| D05 | 手机号按钮           | 新用户（`phone-required`）点「手机号快捷登录」，分别允许和拒绝                                   | 允许 → 登录成功；拒绝 → 提示，按钮还能再点                                                                                                                                                          | B/C    |
| D06 | 装修块               | 从 `subpackages/demo/pages/blocks/index` 启动（第 5 节第 4 步），截图                            | 轮播、图片魔方、商品网格和 [S3 截图](spikes/S3/) 里的 `h5-carousel.png`、`h5-imageCube.png`、`h5-productGrid.png` 一致：布局、间距、圆角、字号；超过几个像素的差别截图标出来                        | 不需要 |
| D07 | 商品 → 结算 → 收银台 | 商品页「立即购买」→ 确认订单 → 提交 → 收银台 → 微信支付                                          | 每一步页面正常；点支付后 `requestPayment` 失败（本机没有真商户），小程序给出错误提示、停在收银台，订单仍是待支付。**不要尝试真付款**                                                                | A/B    |
| D08 | 安全区               | 在有底部横条的 iPhone 上看商品页底栏、确认订单的提交栏、购物车结算栏                             | 底栏不被横条挡住，也没有多余空白；顶部导航栏和状态栏不重叠                                                                                                                                          | A/B    |
| D09 | 长列表               | 分类页、商品列表快速上下滑，滑到底加载下一页                                                     | 不卡顿、不闪白；图片按需加载；到底加载更多、没有更多时有提示；低端 Android 上也能滑                                                                                                                 | A/B    |
| D10 | 分享                 | 首页、商品页右上角「…」→ 转发；有朋友圈分享的页面试「分享到朋友圈」；订单页等看菜单              | 卡片标题、图片正确，点卡片打开的是同一个商品；不该分享的页面菜单置灰（C10）。接收人也要是成员才能打开开发版                                                                                         | A/B    |
| D11 | 网络错误态           | 页面打开后关掉 Wi-Fi 和流量，下拉刷新或进入新页面，再恢复网络                                    | 显示可重试的错误态，不白屏；恢复后重试成功（C16）                                                                                                                                                   | A/B    |
| D12 | 包体积               | 开发者工具「详情 → 基本信息」看本地代码大小，和构建时 `size-report` 的输出比；看「代码质量」面板 | 主包、分包、总大小和 `size-report` 一致（差几 KB 以内）；代码质量没有 ES6+ 语法告警                                                                                                                 | 不需要 |
| D13 | 登录后回到原页       | 未登录（或 `phone-required`）时在商品页点「加入购物车」→ 登录页 → 完成登录；然后左上角返回       | 登录后回到**同一个**商品页（`navigateBack`，不是新开一个），页面状态保留；再返回一次就离开商品页，不会再看到一个相同的商品页。从分享卡片直接打开登录页的情况仍然是替换为目标页                      | B/C    |

有真商户、正式域名的发布前检查（真实付款、取消支付、支付中杀进程、会话失效续期），在
[S4 报告](spikes/S4-e2e.md)的「Real-device checklist」里，不属于这份开发期检查。

## 7. 回报结果

把下面的模板填好，贴到 PR 描述或对应流的 `docs/mini/status/<流>.md` 里。截图附在 PR 或对话里，
**不要提交进仓库**。

```md
### 真机检查 <日期>

- 提交：<git rev-parse --short HEAD>
- 构建：scripts/device-build.mjs --origin <源>（size-report：main … KB，总计 … KB）
- 后端：A / B / C
- 设备：<机型>，iOS/Android <版本>，微信 <版本>，基础库 <版本>

| #   | iPhone | Android | 备注                     |
| --- | ------ | ------- | ------------------------ |
| D01 | 通过   | 通过    |                          |
| D02 | 失败   | 通过    | 角标清空后没消失，截图 1 |
| …   |        |         |                          |

失败项：复现步骤、期望、实际、截图编号、控制台报错原文。
```

## 8. 可选：用 miniprogram-ci 出预览码或上传

不开开发者工具，在本机命令行直接出预览二维码（`scripts/preview.mjs`），或上传开发版本供设为体验版
（`scripts/upload.mjs`）。miniprogram-ci **不是**这个仓库的依赖。**不要直接调用
`miniprogram-ci upload/preview`**：只有这两个脚本会核对 size-report 是否通过了这份产物。

**体验版平时不用手动传。** 店主在 GitHub 上批准一次发布（`Deploy to production`），服务端发布成功后，
同一个工作流用同一个提交、对着生产 API 构建，再以 CI 机器人 2 的身份跑 `upload.mjs --confirm`；
这次批准就是下面第 1 条要的同意。密钥和 API 地址放在 GitHub 的 `mini-trial` 环境里，配置见
[deploy/README](../../deploy/README.md)「From GitHub, on approval」。第一次自动上传后，在公众平台
「版本管理」里把「ci机器人2」的开发版本设为体验版，以后它每次上传都直接替换体验版。下面的手动步骤留给
自动上传失败、或要从本机传别的机器人时用。

1. **每次运行都会把 `dist/weapp` 上传到微信服务器**。每一次都要你本人明确同意；agent
   不能自己替你加 `--confirm`。版本号固定取 `package.json` 的 `version`，脚本不接受版本参数。
   **只上传 size-report 通过的产物**：`size-report.mjs` 通过时在 `dist/weapp.gate.json` 记下产物的指纹，
   两个脚本发现产物和指纹对不上（之后又跑了 `dev:weapp` 或裸 `taro build`）就拒绝。开发者工具里的
   「上传」按钮不做这项检查，只对 `device-build.mjs` 刚成功构建出的 `dist/weapp` 使用；它失败时会删掉
   `dist/weapp`。
   **只上传一个提交**：工作区必须干净（git 忽略的文件除外），size-report 通过时记下的提交必须就是
   `HEAD`，且当时工作区也是干净的。`upload.mjs` 还要求这个提交已经在 `origin/master` 上，并且 CI
   （`ci.yml`，「Merge gate & images」）对它的 push 运行结论是 success——和 `deploy/ship.sh` 发布服务端的条件一样，用 `gh`
   查询，所以本机要登录 `gh`。只改了文档的提交 CI 不跑，没有运行记录，脚本会拒绝：检出 CI 跑过的最新提交再构建。
   **只上传连 https 接口的产物**：size-report 通过时同时记下构建所用的 `TARO_APP_API_ORIGIN`；`upload.mjs`
   发现它为空、不是 `https://`，或带了路径，就拒绝。只写在 `.env.*.local` 里的地址 Taro 能读到，size-report
   读不到，所以要在命令前写 `TARO_APP_API_ORIGIN=https://… pnpm --filter @shop/mini build:weapp`，或者用
   `device-build.mjs --origin https://…` 构建。
   `preview.mjs` 用来在合入前看分支，只要求前两条，不查 CI，也允许局域网 http 地址。
2. **上传密钥**：管理员在公众平台 **开发管理 → 开发设置 → 小程序代码上传** 里生成并下载
   `private.wx4f4b772125e155ed.key`。它是凭证：
   - 放在**仓库外**，例如 `~/.config/shop/private.wx4f4b772125e155ed.key`，`chmod 600`；放在仓库里时
     必须被 git 忽略（根目录 `private.*.key`），否则脚本拒绝运行；
   - 用环境变量 `WX_MINI_UPLOAD_KEY_PATH` 指向它；
   - 根目录 `.gitignore` 忽略 `private.*.key`，`mini` 守卫在 `apps/mini` 下发现一个或者 git 里跟踪了一个就失败；
   - 怀疑泄漏就在同一处重新生成，旧的立即作废。
3. **IP 白名单**：同一页面里配置。自动上传从 GitHub 的机器发出，出口 IP 不固定，所以要关闭白名单；
   密钥只放在只给 `master` 用的 `mini-trial` 环境里，泄漏时照上一条重新生成。不用自动上传时可以打开，
   填本机的公网出口 IP（WSL2 和 Windows 共用；家庭宽带的 IP 会变，变了会报 invalid ip）。
4. **安装**（在仓库外）：`npm i -g miniprogram-ci`。
5. **运行**（先用 `device-build.mjs` 构建好）：

   ```sh
   WX_MINI_UPLOAD_KEY_PATH=~/.config/shop/private.wx4f4b772125e155ed.key \
     pnpm --filter @shop/mini exec node scripts/preview.mjs --confirm
   # 二维码默认打印在终端；--qr-file /tmp/preview.jpg 存成图片；--robot 1–30 选 CI 机器人编号

   WX_MINI_UPLOAD_KEY_PATH=~/.config/shop/private.wx4f4b772125e155ed.key \
     pnpm --filter @shop/mini exec node scripts/upload.mjs --confirm [--desc "说明"]
   # 上传为开发版本，再在公众平台「版本管理」里设为体验版

   WX_MINI_UPLOAD_KEY_PATH=~/.config/shop/private.wx4f4b772125e155ed.key \
     pnpm --filter @shop/mini exec node scripts/upload.mjs --dry-run
   # 做完上面所有检查，只打印将要执行的 miniprogram-ci 命令（密钥路径显示为 <key>），不上传，不需要 --confirm
   ```

   `--desc` 不填时说明是「版本 提交前 9 位 上海时间」，例如 `1.0.0 70d708b1d 2026-09-25 23:30`。

   两个脚本在这些情况下拒绝运行：没设 `WX_MINI_UPLOAD_KEY_PATH`、密钥不存在或在仓库里且未被忽略、
   `dist/weapp` 没构建或是 `touristappid`、size-report 没通过这份产物、工作区不干净或产物不是 `HEAD` 构建的、
   （仅 `upload.mjs`）提交不在 `origin/master` 或 CI 没通过、没加 `--confirm`、找不到 `miniprogram-ci` 命令
   （也可以用 `MINIPROGRAM_CI_BIN` 指定）。它调用的是 miniprogram-ci 文档里的 `preview` 参数
   （`--pp --pkp --appid --uv -r --qrcode-format --qrcode-output-dest`），第一次用前对照你装的版本的
   `miniprogram-ci preview --help` 核对一遍。

扫出来的是开发版，要求和第 2.1 节一样（扫码人是成员），真机上同样要开「开发调试」才能访问 http 局域网地址。

## 9. 版本号

小程序的版本号只有一个来源：`apps/mini/package.json` 的 `version`（例如 `1.0.0`）。构建时
`config/index.ts` 把它写进包里，每个请求都带 `X-Client-Version: <版本>`（`src/data/api.ts`，
上传图片也一样）；`scripts/preview.mjs` 和 `scripts/upload.mjs` 也用它作为上传版本。服务端据此区分新旧客户端：装修块的
`minClient` 高于这个版本时，这个客户端就不会收到那一块。

- **版本号由店主在公众平台决定，上传时不自己改。** 体验版一律按 `package.json` 现有的版本（目前
  `1.0.0`）上传；只有店主给出新的版本号时，才改 `package.json` 的 `version`，然后照常构建
  （`pnpm --filter @shop/mini build` 或 `device-build.mjs`）并提交这次改动。
- CI 或临时构建可以用环境变量 `TARO_APP_VERSION=1.2.0-rc.1` 覆盖，不改文件；`turbo` 的 `build`
  已声明这个变量。
- 格式必须符合服务端的 `clientVersion`（`1`–`3` 段数字，可带 `-后缀`，最长 32 个字符），否则构建直接失败
  ——不合格式的版本号服务端会忽略，等于没发。
- 真机上核对：「真机调试」的 Network 里任意一个 `/api/v1` 请求的请求头 `X-Client-Version` 是这次的版本号。
