# 通勤哨兵 (Commute Guard)

Alameda ⇄ SF（渡轮 + Muni）通勤预警，装在 iPhone 主屏幕上的 App。按你**每天自己的时间**盯着你的路线：

- **通勤时每 10 分钟查一次 511**：你那班船取消/晚点、Muni 停运、可能迟到 → 马上推送；问题恢复了也推一条「✅ 已恢复」。
- **关键时间点由 Claude 用中文分析**：影不影响你、坐哪一班、几点到、Plan B 怎么走。
- **晚上回家也管**：下班前检查回程，回程路上同样每 10 分钟查。

| 检查 | 什么时候（按你当天的时间算） | 回答 |
|---|---|---|
| 睡前检查 | 前一晚 21:30（可改） | 明天要不要定早闹钟？ |
| 起床检查 | 出门前 50 分钟 | 要不要起来准备？ |
| 出门检查 | 出门前 15 分钟 | 要不要出门？坐哪班、几点到？ |
| 船上检查 | 上船后 10 分钟 | 到 SF 后 Muni 能不能坐？不能的话 Plan B |
| 下班检查 | 下班前 30 分钟 | 回家的路通不通？ |
| 突发分析 | 10 分钟巡查发现新问题时 | 影响多大、现在怎么走 |

结论分 🟢 正常 / 🟡 注意 / 🔴 别去（附 Plan B）。Claude 15 分钟内没给出结果，Worker 会推送自己按规则做的自动检查结果——没消息不代表没问题。

## 架构

```
iPhone 主屏幕「通勤哨兵」(PWA) ◀──── Web Push 通知 ────┐
   │ 看状态 / 设时间 / 设路线                            │
   ▼                                                    │
Cloudflare Worker + KV（cron 每 5 分钟）─────────────────┘
   ├─ 通勤时段：每 10 分钟拉 511 → 新问题 / 更严重 / 已恢复 → 立刻推送
   ├─ 到检查点、或发现新问题 → 叫醒 Claude routine（API 触发）
   ├─ Claude 没按时回 → 推送自动检查结果
   └─ 每晚按明天的时间用 Transitous 重新排班次
                │ fire
                ▼
Claude Code routine（只有 API 触发）
   ├─ checker/collect.mjs --remote：从 Worker 拿整理好的数据（digest）
   ├─ Claude 按 routine/PROMPT.md 判断 → verdict.json
   └─ checker/publish.mjs：写回 Worker → 推送到手机
```

全部免费：511.org、NWS、Transitous、Cloudflare Workers 免费额度、Web Push；routine 用你 Claude 订阅的额度。

## 部署（一次性，约 20 分钟）

1. **511 token**：<https://511.org/open-data/token> 填邮箱，几分钟后收到。写进 `.env`：`API_511_KEY=...`
2. **部署 Worker**：
   ```bash
   npm install
   wrangler login                       # 浏览器里授权 Cloudflare
   bash scripts/setup-cloudflare.sh     # 建 KV、生成密码和推送密钥、部署
   ```
   脚本最后打印网站地址和访问密码（也存在 `.env`，不进 git）。
3. **装到 iPhone**（iOS 16.4 以上）：Safari 打开网站 → 输入访问密码 → 分享 → **添加到主屏幕** → **从主屏幕的图标打开** → 点「开启通知」→ 允许。会收到一条测试通知。
   建议到 iPhone「设置 → 专注模式」把通勤哨兵加进允许的 App，否则专注模式下不会响。
4. **设置**：App 右上角「设置」→ 家和公司地址 → 每天的出门 / 最晚到 / 下班时间 → 选去程路线 → 选回程路线 → 保存。
5. **Claude routine**（让通知带中文分析和 Plan B；不做这步也能用，只是推送自动检查结果）：
   1. 代码推到 GitHub（routine 从 GitHub 拉代码）。
   2. <https://claude.ai/code> → 环境设置 → 新建环境 `commute-guard`：
      - Network access：**Custom**，Allowed domains 只填网站域名（如 `commute-guard.xxx.workers.dev`）
      - Environment variables：`CG_BASE_URL=<网站地址>`
      - Network secrets → Add secret：Allowed websites 填网站域名，Header `Authorization`、Prefix `Bearer`、Value 填 `.env` 里的 `CG_WRITE_TOKEN`
   3. <https://claude.ai/code/routines> 新建 routine：选这个 repo、`commute-guard` 环境、模型 Sonnet，**去掉所有 connectors**，**不要加定时**，Prompt：
      ```
      按照仓库里 routine/PROMPT.md 执行一次通勤检查。参数（MODE / DATE / DIR / REASON）在 <routine-fire-payload> 里。
      ```
   4. 在这个 routine 上 **Add API trigger**，复制 URL 里的 routine id（`trig_…`）和 token（`sk-ant-oat01-…`，只显示一次），写进 `.env`：
      ```
      ROUTINE_ID=trig_...
      ROUTINE_TOKEN=sk-ant-oat01-...
      ```
      再运行一次 `bash scripts/setup-cloudflare.sh`。
   5. App 里点「让 Claude 看一下」，几分钟后应该收到 Claude 的分析推送。

## 日常

- **请假/放假**：首页「请假 / 暂停」，那天不检查也不推送。
- **改时间、换路线**：「设置」页。每个时间会自动排好那天坐的班次；晚于「最晚到」会标出来。
- **推送规则**：有问题、更严重了、已恢复、可能迟到 —— 一定推送。一切正常时，只有在「设置 → 正常时也通知」里勾选的检查才推。
- **立即检查**：首页按钮，马上查一次 511（不等 10 分钟）。
- 首页「最后检查 X 分钟前」超过 20 分钟会变红：说明系统可能出问题了，自己看一眼 511。

## 本地开发

```bash
npm test                                    # 离线测试（checker/fixtures 的假数据 + Worker 巡查逻辑 + 推送加密）
node checker/collect.mjs --mode enroute --fixtures checker/fixtures/muni-down --now 2026-10-14T13:57:00Z
cp worker/.dev.vars.example worker/.dev.vars && npm run dev   # 本地 Worker：http://127.0.0.1:8787
node scripts/mock-511.mjs                   # 假 511 + 假推送服务（.dev.vars 里 API_511_BASE=http://127.0.0.1:8788）
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"     # 手动触发一次 cron
```

`checker/fixtures/` 里的场景：`normal`、`ferry-canceled`、`ferry-canceled-no-timetable`、`muni-down`、`enroute-normal`、`night-planned`、`paused`、`no-route`、`source-error`、`evening-ferry-canceled`。

## 已知局限

- 最多晚约 10 分钟发现问题，再加上交通公司自己发公告的延迟。Claude 的详细分析还要几分钟（routine 启动时间官方没写）。
- iPhone 网页 App 的通知不能穿透静音/专注模式（要在专注模式里允许通勤哨兵）；把主屏幕图标删掉，通知就没了。
- 511 公告大多是英文：Worker 的即时提醒会带英文原文，Claude 的分析是中文。
- Cloudflare 免费版每次运行只有约 10ms CPU，所以每次 cron 最多做一件重活（查 511 / 兜底 / 重新排班次），其余等 5 分钟后。上线后用 `wrangler tail` 看有没有超时。
- 不支持跨午夜的通勤。
- Claude routine 还是研究预览，API 触发接口以后可能变。
- 511 每个 key 每小时 60 次：Worker 巡查每小时约 30 次，Claude 每次分析大多复用 Worker 刚拉的数据；突发分析每小时最多 3 次。
