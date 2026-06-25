import {
  analyzeTaxScenarioInput,
  costCorrectionKeyForRealizedTradeId,
  mergeParsedInputs,
} from "@/lib/tax/calculator";
import { taxConfigForYear } from "@/lib/tax/config";
import { parseFutuWorkbooks, type ManualCostInput } from "@/lib/parsers/futu";
import { parseLongbridgePdfs } from "@/lib/parsers/longbridge";
import { parseTigerPdfs } from "@/lib/parsers/tiger";
import { ParserValidationError } from "@/lib/parsers/common";
import type { CostBasisCorrection, CostBasisMethod, ParsedInput, TaxAnalysis } from "@/lib/tax/types";

export type BrokerId = "futu" | "longbridge" | "tiger";

export interface UploadFileEntry {
  id: string;
  name: string;
  broker: BrokerId;
  fingerprint?: string;
  file?: File;
}

export interface AnalysisResult {
  parsedInput: ParsedInput;
  byMethod: Record<CostBasisMethod, TaxAnalysis>;
}

function filterByTaxYear(input: ParsedInput, taxYear: number): ParsedInput {
  const prefix = String(taxYear);
  return {
    ...input,
    dividends: input.dividends.filter((dividend) => dividend.date.startsWith(prefix)),
    openPositions: input.openPositions,
    taxStatementSummaries: input.taxStatementSummaries.filter((summary) => {
      const startYear = Number(String(summary.periodStart ?? "").slice(0, 4));
      const endYear = Number(String(summary.periodEnd ?? "").slice(0, 4));
      if (!Number.isFinite(startYear) && !Number.isFinite(endYear)) return true;
      if (Number.isFinite(startYear) && Number.isFinite(endYear)) return startYear <= taxYear && endYear >= taxYear;
      return startYear === taxYear || endYear === taxYear;
    }),
  };
}

function issueDateYears(input: ParsedInput) {
  const years = [
    ...input.tradeActivities.map((activity) => activity.date),
    ...input.realizedTrades.map((trade) => trade.sellDate),
    ...input.dividends.map((dividend) => dividend.date),
    ...input.openPositions.map((position) => position.asOf),
    ...input.costBasisRequests.map((request) => request.sellDate),
    ...input.taxStatementSummaries.flatMap((summary) => [summary.periodStart, summary.periodEnd]),
  ]
    .map((date) => Number(String(date ?? "").slice(0, 4)))
    .filter((year) => Number.isFinite(year) && year >= 2000);
  return Array.from(new Set(years)).sort((a, b) => a - b);
}

function withTaxYearIssues(input: ParsedInput, taxYear: number): ParsedInput {
  const years = issueDateYears(input);
  const otherYears = years.filter((year) => year !== taxYear);
  if (otherYears.length === 0) return input;

  const hasSelectedYear = years.includes(taxYear);
  const issue = hasSelectedYear
    ? {
        id: `${taxYear}-mixed-report-years`,
        severity: "info" as const,
        title: "导入了跨年成本材料",
        detail: `当前选择 ${taxYear} 纳税年度，导入材料还包含 ${otherYears.join("、")} 年记录。系统会用较早年度的买入/转入记录补充成本，但盈亏明细和税额只展示、计算 ${taxYear} 年的卖出与分红。`,
      }
    : {
        id: `${taxYear}-report-year-mismatch`,
        severity: "warning" as const,
        title: "导入材料年份与纳税年度不一致",
        detail: `当前选择 ${taxYear} 纳税年度，但导入材料只识别到 ${otherYears.join("、")} 年记录。系统会继续按 ${taxYear} 年计算，非本年度的卖出不会进入盈亏明细；若这些材料只是为了补充跨年成本，请同时导入 ${taxYear} 年有卖出/分红的报告。`,
      };

  return {
    ...input,
    issues: [...input.issues, issue],
  };
}

export function recomputeAnalyses(
  parsedInput: ParsedInput,
  taxYear: number,
  costCorrections: CostBasisCorrection[] = [],
): Record<CostBasisMethod, TaxAnalysis> {
  const scoped = filterByTaxYear(withTaxYearIssues(parsedInput, taxYear), taxYear);
  const config = taxConfigForYear(taxYear);
  return {
    fifo: analyzeTaxScenarioInput(scoped, taxYear, "fifo", config, costCorrections),
    acb: analyzeTaxScenarioInput(scoped, taxYear, "acb", config, costCorrections),
  };
}

export { costCorrectionKeyForRealizedTradeId };

export async function analyzeUploadedFiles(options: {
  files: UploadFileEntry[];
  taxYear: number;
  password?: string;
  manualCosts?: ManualCostInput[];
  costCorrections?: CostBasisCorrection[];
}): Promise<AnalysisResult> {
  const realFiles = options.files.filter((entry) => entry.file);
  if (realFiles.length === 0) {
    throw new ParserValidationError("请先上传至少一份券商文件。");
  }

  const seenFiles = new Map<string, string>();
  for (const entry of realFiles) {
    if (!entry.file) continue;
    const key = entry.fingerprint ?? `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`;
    const existing = seenFiles.get(key);
    if (existing) {
      throw new ParserValidationError(`重复上传同一份报告：${existing} 与 ${entry.file.name}。请删除重复文件后再解析。`, entry.file.name);
    }
    seenFiles.set(key, entry.file.name);
  }

  const futuFiles: Array<{ name: string; data: ArrayBuffer }> = [];
  const longbridgeFiles: Array<{ name: string; data: ArrayBuffer }> = [];
  const tigerFiles: Array<{ name: string; data: ArrayBuffer }> = [];

  for (const entry of realFiles) {
    const file = entry.file;
    if (!file) continue;
    const lower = file.name.toLowerCase();
    if (entry.broker === "futu") {
      if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
        throw new ParserValidationError(`${file.name} 被标记为富途，但富途解析器只接受 Excel 年度报表。`, file.name);
      }
      futuFiles.push({ name: file.name, data: await file.arrayBuffer() });
    } else if (entry.broker === "longbridge") {
      if (!lower.endsWith(".pdf")) {
        throw new ParserValidationError(`${file.name} 被标记为长桥，但长桥解析器只接受 PDF 月结单。`, file.name);
      }
      longbridgeFiles.push({ name: file.name, data: await file.arrayBuffer() });
    } else {
      if (!lower.endsWith(".pdf")) {
        throw new ParserValidationError(`${file.name} 被标记为老虎，但老虎解析器只接受 PDF 税表或活动报表。`, file.name);
      }
      tigerFiles.push({ name: file.name, data: await file.arrayBuffer() });
    }
  }

  const inputs: ParsedInput[] = [];
  if (futuFiles.length > 0) {
    inputs.push(parseFutuWorkbooks(futuFiles, options.manualCosts ?? [], options.taxYear));
  }
  if (longbridgeFiles.length > 0) {
    if (!options.password?.trim()) {
      throw new ParserValidationError("检测到长桥 PDF 月结单，请先填写长桥 PDF 密码（手机号后四位 + 身份证后四位）后再解析。");
    }
    const parsed = await parseLongbridgePdfs(longbridgeFiles, options.password, {
      targetYear: options.taxYear,
      manualCosts: options.manualCosts ?? [],
    });
    const blocking = parsed.issues.find((issue) => issue.severity === "blocking");
    if (blocking) {
      throw new ParserValidationError(`${blocking.title}：${blocking.detail}`, blocking.source);
    }
    inputs.push(parsed);
  }
  if (tigerFiles.length > 0) {
    const parsed = await parseTigerPdfs(tigerFiles);
    const blocking = parsed.issues.find((issue) => issue.severity === "blocking");
    if (blocking) {
      throw new ParserValidationError(`${blocking.title}：${blocking.detail}`, blocking.source);
    }
    inputs.push(parsed);
  }

  const parsedInput = mergeParsedInputs(inputs);
  return {
    parsedInput,
    byMethod: recomputeAnalyses(parsedInput, options.taxYear, options.costCorrections ?? []),
  };
}
