# mecha-core：机娘立绘两段式数据集

上一批 `mecha-1123` 按题材标签（`mecha_musume`）扫全站，485 张里严格筛完只剩 35 张能当立绘，而且两套配色体系混在一起。标签捞不出风格统一的东西。

这批换成**两段式**：一段学结构，一段学质感。

```
阶段1  struct：白底全身机娘的构图 / 机械结构 / 人体比例  → LoRA A 出底图
阶段2  gloss ：把底图 img2img 重绘成韩系质感            → LoRA B，denoise 0.40-0.50
```

为什么不能一只 LoRA 学完：现有池里「韩系质感」和「机娘」是两个不相交的集合。按质感质心排序 top120 里机娘 0 张，全池 86 张机娘一张都没进这个簇。交集为零，就意味着任何单只 LoRA 只能在两者里挑一个。

拆成两段之后，矛盾从「权重里打架」变成「推理时调 denoise」，是一个可以实验的旋钮。


## 风格基准不是写出来的，是量出来的

基准取自项目存量池里那 49 张「白底 + 全身 + 机娘」，量化结果在 `style-anchor/profile.json`：

| 维度 | p10 | 中位 | p90 |
|---|---|---|---|
| 平均饱和度 | 0.158 | 0.276 | 0.401 |
| 拉普拉斯方差（归一化 h=1024） | 399 | 919 | 1939 |
| 高宽比 h/w | 1.00 | 1.29 | 1.46 |
| 四角纯白占比 | 0.99 | 1.00 | 1.00 |

这张表就是三道闸：饱和度落在 0.158–0.401 之外，说明配色体系不是这套；拉普拉斯方差低于 399，说明细节密度不够（或干脆是线稿）；高宽比低于 1.15，说明不是立绘构图。

`style-anchor/anchors.tsv` 是这 39 张的逐张指标，`profile.json` 的 `acceptance` 段是机器可读的阈值。新采的图先过这三道闸，再谈好不好看。

## 质感段基准：差别不在配色，在细节密度

`style-anchor/profile-gloss.json` 是从质检出的 12 张韩系图出发、用向量在存量池里检索出的 120 张同族图算的：

| 维度 | struct（39 张） | gloss（120 张） |
|---|---|---|
| 饱和度中位 | 0.276 | 0.284 |
| 拉普拉斯方差中位 | 919 | **538** |
| 高宽比中位 | 1.29 | 1.46 |

饱和度几乎一模一样，差的只有细节密度——差 41%。这个发现决定了整条路线的可行性：**repaint 只需要调一个轴，不用同时改配色和结构**。真要改配色的话 denoise 得开到很高，构图就保不住了。

质感段的数据来源和允许范围跟结构段不同：只要竖幅、成图、非 explicit 就行，不要求白底全身——因为 repaint 不吃背景干净，也不吃构图规范。


## 目录约定

```
mecha-core/
├── catalog.json          源清单：段（struct/gloss）、目标张数、池内已有、风格适配度、弃用理由
├── style-anchor/         结构段基准：profile.json + anchors.tsv + profile-gloss.json
├── gloss-seed/           质感段种子：那 12 张
├── gloss-pool/           质感段主体：向量检索出的 68 张同族（非 explicit）
├── artists/<slug>/       每个画师一个目录，meta.json 由 catalog.json 生成
├── ips/<slug>/           每个作品一个目录，同上
├── meta/                 批次级元信息（采集日志、审计结果）
└── sheets/               分页 contact sheet
```

每个 source 的 `line` 字段决定它喂给哪一段。`struct` 段的图要过白底全身的硬条件，`gloss` 段只要竖幅成图。


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

**repaint 会不会把结构改掉。** 这是整条路线唯一的真风险。denoise 低于 0.35 质感刷不上去，hires 那轮实测 0.35 等于没做；高于 0.55 构图和机械结构开始漂。0.40–0.50 是估的甜点，必须实测出两条边界：能改质感的最小值、开始改结构的最大值。这两个数之间如果没有缝隙，两段式就不成立。

**struct 段的质感不纯能忍到什么程度。** 结构段的图来自战双/明日方舟那路冷硬厚涂，跟韩系差得最远。理论上底图质感会被 repaint 覆盖，但如果 denoise 不够高，残留会变成「韩系高光 + 冷硬底色」的夹生感。建议先拿战双那 39 张单独试 repaint，那是压力最大的样本。

另一个老问题是 IP 既视感：caption 一律不写角色名，单角色控制在 3–5 张，靠角色数量稀释。

## 下一步

1. 质感段先跑通：拿 68 张训一只质感 LoRA，别等结构段采完
2. 拿现有 39 张 struct 底图做 repaint 梯度实验，扫 denoise 0.30/0.35/0.40/0.45/0.50/0.55，同时量结构保持（余弦）和质感接近（与 gloss 质心的距离）
3. 甜点定下来之后再决定要不要扩采 struct——如果不扩也能靠 repaint 达到目标，那 540 张的采集目标可以直接砍
4. 结构段补采时每个 source 先跑 20 张验风格再放量

