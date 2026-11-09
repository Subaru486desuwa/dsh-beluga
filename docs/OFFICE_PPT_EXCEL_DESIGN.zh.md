# Office 下一阶段设计：PPT 生成与 Excel 补齐

日期：2026-11-08。状态：**Excel 部分和 PPT P0 已实现（2026-11-08）；PPT P1、P2 仍是设计稿**。生成库 pptxgenjs 4.0.1 已精确锁定在 Office 扩展里。

## 结论

- **PPT 新增 `create_presentation`**。模型只选择固定版式并填写内容，坐标和字号由引擎计算。生成用 pptxgenjs，生成后统一处理主题字体，并做确定性的版面检查。
- **PPT 修改放第二步**。先升级 PPTX 读取，按页、形状和段落定位；再新增 `edit_presentation`。修改沿用 Word/Excel 已有的 OOXML 补丁方式，未涉及的部件保持原字节。
- **Excel 补两项（已实现）**：原生图表（引用单元格范围，随数据更新；新建和修改工作簿都能加），以及新建工作表的打印适配。不做插入或删除行列。
- 版本、权限、临时聊天、预览和 PDF 都沿用现有产物管线（`stage()`、`checkDocument`、`previewFile`、`exportPdf`），不需要新的存储结构。

## 现状

### Excel：工具已经齐全，但还没有用真实模型验收

| 工具 | 能力 | 限制 |
|---|---|---|
| `create_workbook` | 最多 32 个工作表；单元格支持文本、数字、布尔、空值、公式和日期；表头样式、筛选、冻结、列宽、数字格式；原生图表；打印缩放为一页宽 | 不能设置合并单元格、条件格式和数据验证 |
| `edit_workbook` | 改指定单元格，可以在已有数据后面写新行；可以加原生图表；其余部件保持原样；原文件保留为上一个版本 | 不能增加工作表，不能插入或删除行列；不能修改已有图表；不改合并区的非首格、表格表头和数组公式 |
| `read_sheet` | 按矩形范围读取，同时列出公式；用 `nextRange` 续读 | — |
| 生成或修改后的检查 | 用 LibreOffice 重算，返回公式数、错误单元格和引擎不支持的函数 | 个别函数的结果可能和 Excel 不同 |

`workbook-write.spec.ts` 有 20 项单元测试，`workbook-charts.spec.ts` 有 12 项，`runtime.spec.ts` 覆盖工具调用链路。产物还没有在真正的 Excel 中打开过。设计时新建工作表没有设置打印缩放，列多时导出 PDF 会把右侧的列切到下一页（基线里第 5 列被打印到了第 2 页）；现在缩放为一页宽。

### PPT：能读能看，能生成，不能修改

- **读取**：`read_attachment` 按页输出文字和备注，没有形状、位置、表格或图表的结构。
- **预览和 PDF**：引擎和文件卡已经支持 PPTX，上传的演示稿可以预览，也可以导出 PDF。
- **生成**：`create_presentation` 已实现（2026-11-08）。**修改**：仍缺失，见第二步。

## 试验记录（2026-11-08）

用 pptxgenjs 4.0.1 生成了 4 页样例：标题页、中英文要点、原生柱状图、表格，其中两页带备注。生成后用 Office 扩展现有的 `@deepseek-ai/libreoffice-kit` 渲染。

| 项目 | 结果 | 设计中的处理 |
|---|---|---|
| 生成 | 100 KB，22 ms，完全在内存中完成 | 临时聊天可以生成 |
| 渲染 | 4 页全部打开，每次约 2.5 秒；中文正常 | `check` 复用 `checkDocument` |
| 图表 | 原生图表，内嵌 `Microsoft_Excel_Worksheet1.xlsx`，可在 PowerPoint 中“编辑数据” | 满足“图表保持可编辑” |
| 字体 | 文本不单独写字体，继承主题；但主题的东亚字体为空 | 后处理把主题的 `ea` 设为 Microsoft YaHei，已验证生效 |
| 写死的 Arial | 母版里有 9 处、图表里有 5 处，引擎报告缺少 Arial | 后处理改为引用主题字体（`+mn-lt` / `+mn-ea`） |
| 坐标轴 | 柱状图的值在 54,000–62,000 之间，数值轴从 50,000 开始，夸大了差异 | 柱状图和条形图强制从 0 开始，数值显示千分位 |
| 默认样式 | 白底黑字，表格里的数字左对齐 | 内置一套主题和版式规则 |
| 本地文件和网络 | 在 Node 中，图片给的是 `path` 时，pptxgenjs 用 `node:fs` 读本地文件，或用 `node:https` 下载 | 封装层只传 `data`；工具参数里没有路径或 URL 字段 |
| 依赖 | jszip、image-size、`@types/node`，还有 `https@1.0.0`：一个只有 `package.json` 的占位包，实际代码用的是 `node:https` | 用 pnpm overrides 排除，或接受；打包检查确认它不进入运行路径 |

## 选型

查询于 2026-11-08。

| 方案 | 许可证 | 成熟度 | 能力 | 评价 |
|---|---|---|---|---|
| **pptxgenjs 4.0.1** | MIT | 周下载约 660 万；最后一次发版在 2025-06，仓库未归档，有 309 个未关闭的 issue | 只能生成：原生图表、表格、备注、母版 | **推荐用于新建**。维护放慢了，所以固定精确版本，并且只在一个模块里使用 |
| @office-kit/pptx 0.28 | MIT | 2026-07 创建，单人维护，0.x 版本迭代很快 | 生成和编辑；只依赖 fflate | 依赖结构好，但 API 还不稳定。观察到 1.0 再评估 |
| pptx-automizer 0.9 | MIT | 2021 年起 | 基于模板拼页 | 依赖 pptxgenjs 和 xmldom；拼模板的需求留到第三阶段再看 |
| 自己写 OOXML | — | — | 完全可控 | 图表（含内嵌工作簿）和母版的样板代码很多，新建时不划算 |

这和 Excel 现在的分工一致：ExcelJS 只负责新建，修改由自己的 XML 补丁完成，因为没有哪个库能在往返读写时不丢掉它不认识的部件。以后要换库，也只需要改 `presentations.ts` 一个文件。

## PPT 设计

### 第一步：`create_presentation`（P0，已实现）

```jsonc
{
  "title": "2026 预算回顾",
  "slides": [
    { "layout": "title", "title": "2026 预算回顾", "subtitle": "第三季度", "notes": "开场说明口径" },
    { "layout": "metrics", "title": "核心数字", "metrics": [{ "value": "235,000", "label": "实际" }, { "value": "2.17%", "label": "超出预算" }] },
    { "layout": "bullets", "title": "要点", "bullets": ["预算 230,000，实际 235,000", { "text": "市场部超支", "level": 2 }] },
    { "layout": "chart", "title": "按季度", "chart": "column", "categories": ["Q1", "Q2"], "series": [{ "name": "预算", "values": [55000, 57000] }], "unit": "元" },
    { "layout": "table", "title": "汇总", "rows": [["指标", "金额"], ["预算", "230,000"]] },
    { "layout": "two_column", "title": "对比", "left": { "heading": "现状", "bullets": ["…"] }, "right": { "heading": "计划", "bullets": ["…"] } },
    { "layout": "image", "title": "现场", "image": "<本聊天中图片附件的 attachmentId>", "bullets": ["…"] },
    { "layout": "section", "title": "下一步" }
  ]
}
```

- **共 8 种版式**：`title`、`section`、`bullets`、`two_column`、`chart`、`table`、`metrics`、`image`。不开放自由坐标：模型不擅长排几何位置，用固定版式才能保证对齐、不重叠，检查结果也才是确定的。
- **上限**：40 页；每页最多 8 条要点，层级不超过 2 级；每页表格最多 8 列 × 12 行，超出时报错并建议拆页；图表最多 6 个系列 × 24 个类别，饼图只有 1 个系列，最多 8 块；每页备注最多 4,000 字；整个输入最多 256 KiB，与 Word 相同。
- **图表类型**：`column`、`bar`、`line`、`pie`、`doughnut`，都生成原生图表并内嵌数据。柱状图和条形图从 0 开始，数值显示千分位，饼图显示百分比。
- **主题**：内置一套 16:9 主题。主色沿用 Excel 表头的 `#1F4E79`。字体用主题的 major/minor：西文 Calibri，东亚文字 Microsoft YaHei，所有文字都引用主题字体，这样以后换主题只需替换 `theme1.xml`。表格表头加底色，数字列右对齐。
- **文字适配**：引擎估算每个文本区能放下多少字。中日韩字符按 1 em 宽、其他字符按 0.55 em 宽（宁可估大），行高取 1.32 em（Microsoft YaHei 的行距）。从版式默认字号（标题 32 pt，正文 22 pt）开始，每次缩小 2 pt，最小到标题 24 pt、正文 16 pt。最小字号还放不下时，照常交付文件，同时在 `check.issues` 中报告 `overflow`，指出是哪一页、哪个区域，让模型去拆页。不依赖 autofit，因为它是否生效取决于打开文件的软件。
- **图片**：只接受当前分支上已附加的 PNG 或 JPEG 附件，权限检查和 `read_attachment` 相同。宿主读出字节后以 `data` 传给引擎；不支持 URL，也不支持路径。
- **返回结果**：`check = { opened, slides, missingFonts, issues }`。前三项来自引擎渲染，临时聊天中跳过，与 Word 相同。`issues` 来自版面估算，不写任何文件，所以临时聊天也会返回。
- **版本**：沿用 `stage()`，摘要为 `Created presentation`，文件名为 `fileName(title, 'presentation') + '.pptx'`。
- **实现补充（2026-11-08）**：标题放进母版的标题占位符并左对齐（pptxgenjs 母版默认居中）。生成后把项目符号和图表里写死的 Arial 改为引用主题字体，给主题补上中文字体；备注母版改用自己的主题，`[Content_Types].xml` 只声明存在的部件（pptxgenjs 按每页声明一个母版）。`presentation.xml` 保留 pptxgenjs 的元素顺序，虽然 schema 要求备注母版列表在前：据 pptxgenjs 问题 1443 的报告，改成 schema 顺序的文件在 Mac 版 PowerPoint 打不开。模型通过 `[Image: 名称, attachmentId=…]` 看到图片附件的 id，和文档附件一样；图片仍然只能经 inline 图片路由发送。

改动位置：
- 基础包：`host/presentations.ts`（zod 校验，经 `index.ts` 导出，做法同 `validateDocument`）、`tools.ts` 的工具参数定义、`turns.ts` 的 `executeTool` 分支、文件卡的工具名称和中英文文案。
- 契约：`OfficeEngine.renderPresentation(input, images, signal)`。
- Office 扩展：`presentations.ts`（pptxgenjs 封装加后处理）和 `slide-fit.ts`（文字估算）。
- 基础包不依赖 pptxgenjs，与现在的拆包方式一致。

### 第二步：读取升级与 `edit_presentation`（P1）

- **读取**：`read_attachment` 对 PPTX 改用和 Word 相同的“图例 + 短位置”格式。每页先写一行 `part ppt/slides/slide7.xml (slide 3)`，因为页序以 `sldIdLst` 为准，不按文件编号。下面是形状和段落，例如 `sp2.p1 [title] "…"`、`gf1.t1.r2.c3.p1 "…"`（表格），备注写作 `notes.p1`。
- **修改动作**：
  - 文字级，和 `edit_document` 一样：`replace`、`insert_after`、`delete`。必须给出 `expected`，原文已经变化的段落拒绝修改；保留段落第一个文字片段的格式。
  - 备注：整段替换。
  - 页级：`delete_slide`、`move_slide`。
- **拒绝的对象**：SmartArt、组合形状内的文字、图片，以及图表数据（图表数据放到第三步）。
- **检查**：渲染检查，加上对改动过的形状估算是否溢出。字号能从文字片段、版式或母版中解析出来时才估算；解析不出时，说明没有检查。
- 每次修改产生一个新版本，原件保留。

### 第三步（P2）

- `add_slide`：用这份演示稿自己的版式和占位符新增一页，让上传的模板稿保持原有风格。
- 修改图表数据：同步更新图表 XML 的缓存和内嵌工作簿。
- `create_presentation` 增加 `template`：沿用上传 `.pptx` 或 `.potx` 的母版和主题。这需要自己克隆页面，和 `add_slide` 一起做。
- 跨文件一致：图表增加 `source: { attachmentId, sheet, range }`，从本聊天的 XLSX 读取重算后的值，保证 Word、Excel、PPT 中的数字一致。

## Excel 设计

1. **原生图表（P0，已实现）**：`create_workbook` 和 `edit_workbook` 都增加 `charts: [{ sheet, chart, title, categories: "A2:A5", series: [{ values: "B2:B5", name }] }]`，`chart` 取 `column`、`bar`、`line`、`pie`。
   - 图表引用单元格范围，数据改了图表跟着变。系列名默认引用值区域上方（按行排列时是左侧）的表头单元格。
   - 实现时去掉了 `anchor`：图表自动放在数据右侧、空一列的位置，约 9 列 × 17 行；同一工作表的图表依次往下排，不压住已有的图片和图表。
   - ExcelJS 不能写图表，所以在重算之后用 `OfficePackage.rewrite` 补进 drawing、chart、关系和内容类型，缓存是计算后的值。临时聊天不计算，公式结果在缓存里留空，Excel 打开时会计算。
   - 坐标轴：柱状图和条形图在所有值已知且非负时从 0 开始，有负值或待计算的值时由软件自动决定；类别标签放在最低处，不压住负值的条。数字格式取源单元格的格式代码，写进缓存和坐标轴并标 `sourceLinked`，所以 `#,##0` 在 Excel 和 LibreOffice 中都显示千分位。日期、时间、货币和会计等随地区变化的内置格式退回 `General`。
   - 饼图只有一个系列，每块单独着色并显示百分比。系列颜色用 Excel 的强调色。
   - 类别和值都必须是本工作表中的一行或一列，长度相同，最多 1000 个单元格；每次最多 16 个图表，每个最多 12 个系列。`check.charts` 报告每个图表的位置，以及不是数字的值单元格。
   - 不能修改或删除已有图表。修改单元格后，已有图表的缓存不刷新：Excel 和 LibreOffice 打开时按单元格重画，只读缓存的程序会看到旧值。
   - 手写的部件用 `scripts/ooxml-schema-check.py` 按 ECMA-376 过渡 schema 校验，代替在 Excel 中打开：Excel 会拒绝或“修复”违反 schema 的文件，LibreOffice 不会。
2. **打印适配（P0，已实现）**：新建的工作表都缩放为一页宽（`fitToWidth: 1, fitToHeight: 0`）；超过 6 列或带图表时横向打印。这样 PDF 不会再把列切到下一页。
3. **增加工作表（P1）**：`edit_workbook` 支持 `add_sheet`，需要写入 workbook.xml、关系、内容类型和新的工作表部件。
4. **暂不做**：插入或删除行列（要同时改写公式、图表、名称和合并区中的引用，容易出错），以及条件格式、数据验证、数据透视表。有实际需求时再加。

## 实施顺序与验收

1. Excel 原生图表和打印适配：已完成（2026-11-08），验收记录见 `ACCEPTANCE.md`。
2. PPT P0（create_presentation、主题、文字适配、检查）：已完成（2026-11-08），验收记录见 `ACCEPTANCE.md`。
3. PPTX 读取升级和 `edit_presentation`。
4. 第三步各项。

PPT P0 验收：
- 用合成预算材料生成一份 8 页的演示稿，每种版式用一次。引擎能打开，页数为 8，中文可见；图表含内嵌工作簿，柱状图从 0 开始。230,000、235,000、5,000、2.17% 与 Word、Excel 产物一致。
- 文字过多的页面会收到 `overflow`；模型拆页后不再出现。
- 临时聊天中不写文件、不渲染，但仍然返回 `issues`。
- 测试断言：传给 pptxgenjs 的图片参数只有 `data`；参数里出现 URL 或路径会被 schema 拒绝。
- 隔离 UI 验收沿用固定装置模型和 `TOOL` 关键词。用户验收通过后，备份并部署到日常服务。
- **还没有验证的**：在真正的 PowerPoint 或 Keynote 中打开，需要用户在 Mac 或 Windows 上确认；真实模型选择版式和写作的质量。
- 结果（2026-11-08）：以上各项通过，见 `ACCEPTANCE.md`。图片版式在浏览器里验收需要 inline 图片路由，改由运行时测试经本地路由覆盖。

## 待确认

1. 已定：生成库用 pptxgenjs，锁定 4.0.1（2026-11-08，用户确认开始 PPT P0）。
2. 已定：用固定版式（同上）。
3. 已定：先补 Excel 图表（2026-11-08），已完成；下一步是 PPT P0。
