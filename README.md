# 通勤哨兵 (Commute Guard)

Alameda → SF（渡轮 + Muni）通勤预警。每个工作日在 4 个时间点检查你的路线，有问题推送到手机：

| 检查 | 时间 | 回答 |
|---|---|---|
| 睡前检查 | 前一晚 21:30 | 明天要不要定早闹钟？ |
| 起床检查 | 05:37 | 要不要起来准备？ |
| 出门检查 | 06:17 | 要不要出门？ |
| 船上检查 | 06:57 | 到 SF 后 Muni 能不能坐？不能的话 Plan B |

结论分 🟢 正常 / 🟡 注意 / 🔴 别去（附 Plan B）。如果某次检查到点没出结果，会另外推一条「⚠️ 检查没有运行」——没消息不代表没问题。

## 架构

```
手机 ntfy App ◀── 推送 ──┐
PWA 网站（状态/设置路线）│
        ▲               │
        │      Cloudflare Worker + KV（存路线、存结果、推送、看门狗 cron）
        │               ▲
        │               │ POST 结果
  Transitous（设置路线时   Claude Code routines ×4（云端定时）
  在浏览器里规划）         ├─ checker/collect.mjs：拉 511 + NWS，对上你的路线 → digest.json
                          ├─ Claude 读 digest，按 routine/PROMPT.md 判断 → verdict.json
                          └─ checker/publish.mjs：写回 Worker（Worker 负责推送）
```

全部免费：511.org、NWS、Transitous、ntfy、Cloudflare Workers 免费额度；routine 用你 Claude 订阅的额度。

## 部署（一次性）

1. **511 token**：<https://511.org/open-data/token> 填邮箱，几分钟后收到。
2. **手机装 ntfy**（App Store / Google Play）。
3. **部署 Worker**：
   ```bash
   npm install
   wrangler login                       # 浏览器里授权 Cloudflare
   bash scripts/setup-cloudflare.sh     # 建 KV、生成密码/密钥、部署
   ```
   脚本最后会打印网站地址、访问密码、ntfy topic（也存在 `.env`，不进 git）。在 ntfy App 里订阅这个 topic。
4. **设置路线**：打开网站 → 输入访问密码 → 「路线」→ 输入家和公司地址 → 选你实际走的那条 → 保存。回首页点「发送测试通知」，确认手机收到。
   iPhone：Safari 打开网站 → 分享 → 「添加到主屏幕」，之后就像 App 一样用。
5. **推到 GitHub**（routine 需要从 GitHub 拉代码）。
6. **建云端环境**：<https://claude.ai/code> → 环境设置 → 新建环境 `commute-guard`：
   - Network access：**Custom**，Allowed domains 填 `api.511.org`、`api.weather.gov`，勾选 *Also include default list of common package managers*（要装 npm 包）
   - Environment variables：
     ```
     API_511_KEY=<你的 511 token>
     CG_BASE_URL=<网站地址，例如 https://commute-guard.xxx.workers.dev>
     ```
   - Network secrets → Add secret：Allowed websites 填网站的域名（如 `commute-guard.xxx.workers.dev`），Header `Authorization`、Prefix `Bearer`、Value 填 `.env` 里的 `CG_WRITE_TOKEN`
7. **建 4 个 routine**（<https://claude.ai/code/routines> 或 CLI 里 `/schedule`），每个都选这个 repo、`commute-guard` 环境、模型选 Sonnet，**去掉所有 connectors**：

   | 名字 | 触发 | Prompt |
   |---|---|---|
   | 通勤-睡前 | 每天 21:30 | `按照仓库里 routine/PROMPT.md 执行一次通勤检查，MODE=night。` |
   | 通勤-起床 | 工作日 05:37 | `按照仓库里 routine/PROMPT.md 执行一次通勤检查，MODE=wake。` |
   | 通勤-出门 | 工作日 06:17 | `按照仓库里 routine/PROMPT.md 执行一次通勤检查，MODE=leave。` |
   | 通勤-船上 | 工作日 06:57 | `按照仓库里 routine/PROMPT.md 执行一次通勤检查，MODE=enroute。` |

   睡前检查设成「每天」：周五、周六晚上它会自己跳过（明天不是通勤日），这样不用写自定义 cron。时间不要设整点（整点可能晚几分钟启动）。如果改了时间，同步改 `shared/schedule.mjs` 里的时间，看门狗靠它判断「没运行」。
8. 每个 routine 点 **Run now**，看运行记录、手机推送、网站时间线是否都对。

## 日常

- 请假/放假：首页「这天请假 / 暂停检查」，当天 routine 会静默跳过，看门狗也不会报警。
- 换路线：「路线」页重新选。
- 推送级别：🟢 低优先级（不打扰），🟡 普通，🔴 最高（会响）。

## 本地开发

```bash
npm test                                   # 检查逻辑的测试（离线，用 checker/fixtures 的假数据）
node checker/collect.mjs --mode enroute --fixtures checker/fixtures/muni-down --now 2026-10-14T13:57:00Z
cp worker/.dev.vars.example worker/.dev.vars && npm run dev   # 本地 Worker：http://127.0.0.1:8787
```

`checker/fixtures/` 里有这些场景：`normal`、`ferry-canceled`、`ferry-canceled-no-timetable`、`muni-down`、`enroute-normal`、`night-planned`、`paused`、`no-route`、`source-error`。

## 已知局限

- 不是分钟级实时：4 个检查点之间新出的故障抓不到（routine 最短间隔 1 小时）。
- 数据只和机构发布的一样快；Muni 突发故障时 alert 可能晚几分钟，所以同时看「站点实时预测是否消失」。
- 睡前只能看到可预见的问题（计划停运、罢工、天气预警）。
- 511 的部分接口格式没有官方 JSON 样例，解析写得比较宽松；第一次用真 key 跑时留意 `digest.errors`。
