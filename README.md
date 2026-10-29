# pdfcite

**核验 AI 答案里的每条引文，是否真的出现在源 PDF 的第 N 页。**

RAG 输出的 `[p7]` 是模型自己写的。`pdfcite` 在生成之后独立复核：拿源 PDF 的文本做确定性匹配，
**不调用任何模型、不上传文档、不联网**，用退出码告诉你哪一条引文站不住。

```bash
git clone https://github.com/kylemarvin884/openbot-pdfcite
cd openbot-pdfcite
npm run demo     # 造一份 4 页合同 + 7 条引文，当场看判定结果
```

Node ≥ 22，零依赖（只用内置 `node:zlib`），不需要 `npm install`。

## 示例输出

`npm run demo` 的真实输出（2026-10-30，Windows / Node 24.19）：

```text
pdfcite 0.1.0
packed   agreement.pdf  sha256 0de76f34ab73…
pages    4  chars 683  text_layer good
output   demo/out/ctx/pages.jsonl
         demo/out/ctx/context.md
         demo/out/ctx/manifest.json

pdfcite 0.1.0
answer   demo/out/answer.md
source   agreement.pdf  sha256 0de76f34ab73…  pages 4  text_layer good
quotes   7 → 3 exact, 1 near, 0 partial, 1 split, 1 moved, 1 missing

  ✓ p1    The supplier shall deliver the hardware within thir…   exact match
  ✓ p2    Payment is due within forty-five (45) days of a val…   exact match
  ≈ p2    The customer can withhold payment for defective uni…   near match on the cited page (92.5%)
  ✓ p3    Either party may terminate for convenience with six…   exact match
  ⚠ p3    Confidentiality obligations survive termination for…   quote crosses the page break (p3→p4)
  → p4    Late delivery incurs a penalty of 0.5% of the order…   found on p1, not on the cited page
  ✗ p3    The supplier shall provide a ninety (90) day warran…   not found in the document

2 unverified → exit 1
```

## 用法

```bash
# 1. 把 PDF 拆成带页码锚点的上下文包
node src/cli.mjs pack paper.pdf --out ctx/

# 2. 让任意模型读 ctx/context.md，要求它用 [pN] 标页码

# 3. 核验答案
node src/cli.mjs check answer.md --sources ctx/
```

`pack` 写三个文件：

| 文件 | 内容 |
| --- | --- |
| `pages.jsonl` | 每页一行：`{ page, chars, sha256, text }`，核验只读这个 |
| `context.md` | 带 `## p3` 锚点的全文，直接当模型的上下文 |
| `manifest.json` | 源文件 sha256、页数、`text_layer` 评级、抽取警告 |

`check` 只认一种引文格式：**blockquote + 页码锚点**。

```markdown
> Payment is due within forty-five (45) days of a valid invoice. [p2]

> Termination needs sixty (60) days notice. （第 3 页）
```

支持的锚点：`[p7]`、`[pages 7]`、`(p. 7)`、`(p7)`、`(pp. 7-8)`、`（第 7 页）`。
没有锚点的引用不会被检查——不猜。

## 判定与退出码

| 判定 | 含义 | 是否算失败 |
| --- | --- | --- |
| `✓ exact` | 引文逐字出现在所标页（含忽略词间空格、大小写、连字符换行） | 否 |
| `≈ fuzzy` | 在所标页，但措辞不同（Dice 相似度 ≥ 0.80） | 否，警告 |
| `◐ partial` | 引文前半段逐字在页上，后半段原文没有（模型把句子续写了） | **是** |
| `⚠ split` | 引文跨页（p3 结尾接 p4 开头） | 否，警告 |
| `→ moved` | 原文确实存在，但不在所标的页 | **是** |
| `✗ missing` | 全文找不到 | **是** |

```text
0  没有 missing / partial / moved（fuzzy 和 split 只是警告）
1  至少一条引文不成立
2  用法错误、文件读不到、或 PDF 没有文本层
```

`--json` 输出机器可读结果；`--allow-moved` 把「页码错」降级为警告；`--min-fuzzy 0.9` 收紧近似匹配。

## 放进 CI

```yaml
- run: node pdfcite/src/cli.mjs check answer.md --sources ctx/ --json > pdfcite.json
```

答案里的引文对不上就 fail，交付前最后一道检查。也可以在自己的 RAG 流水线里，把 `pack` 的
`pages.jsonl` 当作唯一可信的来源，答案生成后立刻跑 `check`。

## 和现有工具的区别

| 工具 | 核验对象 | 依赖 | 输出 |
| --- | --- | --- | --- |
| `refchecker` / `hallucinator` / `CiteVerify` | 参考文献条目（作者、DOI、年份是否存在） | 联网 + 学术库，部分需要 LLM key | 条目级报告 |
| 模型驱动的 citation skill | claim↔source 判定 | 每次调用模型，结果不可复现 | 自然语言判断 |
| RAG 框架自带的 citation | 模型自己给出的引用 | 自证 | 无独立核验 |
| **pdfcite** | **正文引文 ↔ 本地 PDF 的页码** | **离线、零模型、零依赖** | **页级判定 + 退出码** |

核的是「这句话在第 7 页吗」，不是「这篇论文存在吗」，也不是「这段引用是否支持结论」。
三者互补，不互相替代。

## 3 个真实用例

1. **合同 / 条款问答**：核对「第 4.2 条」的引文页码，避免把甲方的义务写成乙方的。
2. **券商研报 / 标书**：交付前跑一遍，把页码错误挡在客户看到之前。
3. **论文综述**：核验「某论文说 X」是否真在该页，而不是模型把两篇论文的记忆混在一起。

## 实测范围（不是 benchmark）

在本机（Windows / Node 24.19）跑过两类真实文件：

- **311 页英文手册**（ReportLab 生成，`ASCII85Decode` + `FlateDecode`，文字在 Form XObject 里）：
  抽取 721,646 字符，`text_layer: good`；4 条引文中 2 条 exact、1 条 moved、1 条 partial，判定与原文一致；
  整个 `check` 约 1.8 秒。
- **8 页中文 PDF**（浏览器导出，逐字定位）：抽取 4,204 字符，`text_layer: good`；
  抽取会在英文单词中间插空格（`G itH ub`），匹配时忽略词间空格后可以命中。

没有做过规模化准确率统计。要拿它做验收，请先用自己文档里的 20 条已知引文测一遍。

## 明确的限制

- **不做 OCR**。扫描件直接报 `no text layer` 并退出 2，不猜。
- **不保证阅读顺序**。表格、双栏、逐字定位的 PDF 可能出现行序交错；引文匹配不受影响，
  但 `context.md` 的可读性会下降。
- **CJK 依赖 `/ToUnicode`**。字体没有 ToUnicode 时会退化成 Latin-1，表现为乱码和 `text_layer: low`。
- **不支持**：加密 PDF、`LZWDecode`、Type3 位图字体、bbox 级定位。
- `missing` 不等于「模型一定在撒谎」，也可能是抽取质量问题。先看 `manifest.json` 的 `text_layer`。

## 开发

```bash
npm test        # 40 个测试：PDF 解析、文本抽取、引文解析、匹配、CLI 退出码
npm run demo    # 生成 demo/out/ 下的 PDF、答案和上下文包
```

代码结构：

```
src/pdf/objects.mjs   对象扫描、Flate / ASCII85 / ASCIIHex 解码、object stream 展开
src/pdf/text.mjs      内容流解释器（Tj/TJ/Td/Tm/T*、Form XObject、ToUnicode）
src/pdf/extract.mjs   页树遍历、资源继承、字体 CMap、text_layer 评级
src/pack.mjs          pages.jsonl / context.md / manifest.json
src/quote.mjs         从 Markdown 抽引文和页码锚点
src/match.mjs         归一化、Dice 相似度、判定顺序
src/check.mjs         加载上下文包并逐条核验
src/report.mjs        文本与 JSON 输出
```

MIT license。
