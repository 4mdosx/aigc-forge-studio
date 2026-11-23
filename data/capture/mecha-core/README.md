# mecha-core：机娘立绘风格 / 设计语言数据集

上一批 `mecha-1123` 按题材标签（`mecha_musume`）扫全站，跑完得到 485 张、严格筛完只剩 35 张能当立绘，而且两套配色体系混在一起。结论是标签捞不出风格统一的东西。

这批换锚定方式：**从一个已经统一了的源头取图**——具体画师、具体作品。目录先建好，内容按 `catalog.json` 往里填、按需要调。

## 风格基准不是写出来的，是量出来的

基准取自项目存量池里那 49 张「白底 + 全身 + 机娘」，量化结果在 `style-anchor/profile.json`：

| 维度 | p10 | 中位 | p90 |
|---|---|---|---|
| 平均饱和度 | 0.158 | 0.276 | 0.401 |
| 拉普拉斯方差（归一化 h=1024） | 399 | 919 | 1939 |
| 高宽比 h/w | 1.00 | 1.29 | 1.46 |
| 四角纯白占比 | 0.99 | 1.00 | 1.00 |

这张表就是三道闸：饱和度落在 0.158–0.401 之外，说明配色体系不是这套；拉普拉斯方差低于 399，说明细节密度不够（或干脆是线稿）；高宽比低于 1.15，说明不是立绘构图。

`style-anchor/anchors.tsv` 是这 49 张的逐张指标，`profile.json` 的 `acceptance` 段是机器可读的阈值。新采的图先过这三道闸，再谈好不好看。

## 目录约定

```
mecha-core/
├── catalog.json          源清单：目标张数、池内已有、风格适配度、弃用理由
├── style-anchor/         风格基准（profile.json + anchors.tsv），只存清单不复制图
├── artists/<slug>/       每个画师一个目录，meta.json 由 catalog.json 生成
├── ips/<slug>/           每个作品一个目录，同上
├── meta/                 批次级元信息（采集日志、审计结果）
└── sheets/               分页 contact sheet
```

一个 source 一个目录，目录名用 tag 的 slug 化形式（括号、点号替换成下划线），`meta.json` 里的 `tag` 才是精确的 danbooru 标签。

`catalog_init.mjs` 负责按 `catalog.json` 落目录、写 `meta.json`、回填状态：

```bash
node scripts_and_tools/catalog_init.mjs --batch mecha-core --dry   # 只看
node scripts_and_tools/catalog_init.mjs --batch mecha-core         # 落盘
```

状态三档：`todo` 两处都没有、`partial` 有货但不够目标、`ready` 到位。`existingInPool` 是共享池里按 tag 能筛出来的张数，`downloaded` 是已落进本目录的张数，两个数分开记，因为池里的图还没分配。

## 来源清单

画师是按「在已判过的 485 张里实际画出多少张合规立绘」排出来的，不是凭印象列的。每人再抓 4 张代表作目检过风格。

| 来源 | 类型 | 目标 | 池内已有 | 风格适配 |
|---|---|---|---|---|
| frider | 画师 | 50 | 8 | 贴合：白底全身、软过渡灰白调、机械部件明确 |
| huixing_chloy | 画师 | 50 | 5 | 贴合：白底全身、机械装束、赛璐璐偏精细 |
| aokuma\_(yuuran_create) | 画师 | 40 | 4 | 贴合但偏暗：冷硬装甲，需盯整体亮度 |
| karukan\_(monjya) | 画师 | 40 | 5 | 贴合：绿白机娘+机械臂，样本少需确认产量 |
| yorktown_cv-5 | 画师 | 40 | 7 | 部分：做工扎实但混线稿与半身氛围图 |
| oota_youjo | 画师 | 30 | 9 | 部分：人体与面部好，机械偏弱 |
| soruto_0w98e | 画师 | 30 | 6 | 部分：机械结构最对味，但混多人物设定表 |
| punishing:\_gray_raven | IP | 45 | 52 | 主源：风格锚的最大来源 |
| arknights | IP | 35 | 5 | 厚涂但结构严谨，需筛白底版 |
| arknights:\_endfield | IP | 25 | 4 | 硬表面，注意剔 3D 渲染 |
| goddess_of_victory:\_nikke | IP | 30 | 24 | 韩系高光、比例偏写实，防拉高光 |
| alice_gear_aegis | IP | 25 | 16 | 机械设计最扎实，画风偏明亮 |
| girls'\_frontline | IP | 20 | 4 | 战术装备细节多，排除大场景插画 |
| final_gear | IP | 20 | 4 | 部件拆分清晰，适合补设计语言 |
| frame_arms_girl | IP | 20 | 8 | 官方图多为设定稿，剔 3D 与盒绘 |

目标合计 549 张，池内可筛 210（含重叠，anchor 那 49 张本身就是从 战双/NIKKE/AGA 里出的）。

弃用的记在 `catalog.json` 的 `rejectedSources`，带理由：`esk_(sub_macguffin)` 全是线稿分解图、`gia` 厚涂暗调、`ryan_greythorn` 半身占比过高；作品侧弃 `war_thunder`、`world_of_tanks`、`battle_of_titans`（军事写实/3D 机甲）、`blue_archive`（萌系平涂、机械近乎为零）、`azur_lane`（舰装比例与锚不同，要舰系应另开批次）。

## 采集口径

沿用 `mecha-1123` 摸清的那套 danbooru 规则，别重复踩：

- 匿名账号**最多 2 个标签**，`rating:general` 和 `order:*` 不占配额，其余标签筛选全在客户端做
- `order:score` **不要用来选质量**：实测 score ≥ 60 的 44 张里只有 1 张符合立绘规范，而白底全身那 88 张里 89% 都在 score < 30。评分是热度，它奖励萌系半身和裁切图，惩罚设定稿
- CDN `cdn.donmai.us` 有 Cloudflare，**必须完整 UA + Referer** 才能下载
- `1girl` 误标率约 28%，纯机甲图也挂，靠「人体信号 ≥3」（hair / skirt / blush 等）兜底
- 视角标签基本失效（465/485 未标），四档视角覆盖只能眼判

## 这条线的两个风险

**IP 既视感。** 风格 LoRA 分不清「这套渲染语言」和「这个角色的脸」，用 IP 图必然带进角色特征。所以 caption 一律不写角色名（`artist` / `copyright` 也不进 caption），单个角色控制在 3–5 张，靠角色数量稀释。这一条如果后面发现 LoRA 出图总是像某个既有角色，就得把 IP 那半砍掉，只留画师。

**画师与 IP 的配比还没定。** 现在是画师 290 / IP 215。如果最终要以画师为风格主轴、IP 只补角色多样性，IP 应该压到 150 以内。这个数等第一批图筛完再定，现在留口子。

## 下一步

1. 剔掉 anchor 里那几张 UI 截图和近纯机甲（49 张里有 3–5 张不合格）
2. 按 `catalog.json` 逐个 source 补采，每个 source 先跑 20 张验风格再放量
3. 采回来的统一过三道闸 + 人眼 A/B/C 分级，垫进 `sheets/`
4. 到 300 张以上且饱和度带宽 ≤2 倍，再谈训风格 LoRA
