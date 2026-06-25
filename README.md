# TaxCheck

TaxCheck 是快速为中国大陆居民打造的免费海外资本利得税计算工具，支持把海外证券券商文件整理成个人申报参考底稿。

在线使用：[https://tomczhang.github.io/tax-check/](https://tomczhang.github.io/tax-check/)

![TaxCheck 税务工作台](docs/assets/readme/taxcheck-workbench.png)

## 这个工具解决什么问题

海外券商导出的交易、分红、转仓材料通常分散在不同报表里，个人申报时还需要手动整理成本、汇率、应纳税所得额和海外已纳税额。TaxCheck 把这些步骤放在一个本地浏览器工具里完成：

- 导入券商材料。
- 识别券商和文件类型。
- 计算财产转让所得与利息、股息、红利所得。
- 对比自然年 FIFO / ACB 两种成本法。
- 核对逐笔交易、补充历史成本、订正解析结果。
- 生成可复制数字和可保存 PDF 的申报参考底稿。

## 使用流程

### 1. 根据引导上传券商材料

新手引导会提示富途年度报表、长桥月结单的入口位置，并引导完成上传、解析和生成报告。

![TaxCheck 新手引导](docs/assets/readme/taxcheck-onboarding.png)

### 2. 展开单只股票核对每笔交易

盈亏明细支持展开到每笔卖出记录，核对成交日期、卖出价格、成本、收益，也可以对历史成本或解析成本进行订正。

![TaxCheck 每笔交易详情](docs/assets/readme/taxcheck-trade-detail.png)

### 3. 查看个税网站填写位置

关键指标旁提供填写位置说明，hover 后可以看到对应个人所得税网站模块和字段，减少来回查表。

![TaxCheck 个税网站填写位置提示](docs/assets/readme/taxcheck-tax-form-guide.png)

### 4. 生成申报参考底稿

申报报告会汇总两种成本法的结果、推荐口径、财产转让所得、利息股息红利所得、美股分红抵扣材料和数据来源。可以复制申报数字，也可以保存为 PDF 留档。

![TaxCheck 申报底稿](docs/assets/readme/taxcheck-report.png)

## 主要功能

- 导入富途 Excel 年度报表、长桥 PDF 月结单、老虎 PDF 税表或活动报表。
- 自动识别券商和文件类型，减少手动选择。
- 按纳税年度筛选，支持 2021-2025 年。
- 计算财产转让所得应纳税所得额。
- 计算利息、股息、红利所得应纳税所得额。
- 单独列示美股分红应纳税所得额和海外已纳税额。
- 对比自然年 FIFO 和自然年 ACB 两种成本法。
- 支持历史成本缺失时手动补充成本。
- 支持对已解析成本进行逐笔订正。
- 支持转仓记录查看，辅助判断是否还需要上传其他券商材料。
- 生成申报报告，可复制申报数字或保存为 PDF。

## 支持材料

目前主要支持：

- 富途：“年度报表”Excel。
- 长桥：PDF 月结单。

不支持的单独表格会提示删除后重新解析，例如富途利息表、成交明细、资产流水等独立文件。

## 数据隐私

TaxCheck 承诺不保存任何你的财务数据。上传的券商文件只在浏览器本地解析和计算，不会上传到服务器。

项目使用 Umami 做匿名访问统计，用于了解页面访问量和报告生成次数，不采集券商文件内容、交易明细或个人财务数据。

## 计算口径

- 纳税年度按自然年 1 月 1 日至 12 月 31 日。
- 税率按个人所得税「财产转让所得」和「利息、股息、红利所得」20% 估算。
- 汇率采用对应年度年末人民币汇率中间价口径。
- 财产转让所得和利息、股息、红利所得分项计算，亏损不抵减分红所得。
- FIFO 按先进先出匹配成本，ACB 按平均成本匹配成本。

提示：申报时请保持同一种成本法，不能今年用 FIFO、明年用 ACB，否则可能引起税务核查。

## 本地开发

```bash
npm install
npm run dev
```

本地访问：

```text
http://127.0.0.1:5173/
```

构建：

```bash
npm run build
```

预览构建产物：

```bash
npm run preview
```

## 部署

项目通过 GitHub Actions 部署到 GitHub Pages。

推送到 `main` 分支后会自动执行：

1. `npm ci`
2. `npm run build`
3. 上传 `dist`
4. 发布到 GitHub Pages

部署配置见 [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)。

## 环境变量

GitHub Pages 构建时可配置以下 Repository Variables：

- `UMAMI_SCRIPT_URL`
- `UMAMI_WEBSITE_ID`

本地开发不配置也可以正常运行，只是不会上报 Umami 统计。

## 免责声明

TaxCheck 生成的结果仅供个人申报参考与自查，不构成税务、会计或法律意见。最终申报口径与税额请以主管税务机关要求及专业税务顾问意见为准。

## 友情链接

- [linux.do](https://linux.do/)：中文 AI 学习 & 开发者论坛。

## 制作

本工具由公众号「汤姆喵的奇妙旅行」制作。
