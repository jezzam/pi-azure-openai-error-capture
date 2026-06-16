import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  timestamp: string;
  request: JsonObject;
}

interface CapturedProviderError {
  timestamp: string;
  status: number;
  requestId?: string;
  retryAfter?: string;
  azure: boolean;
  request: JsonObject;
  responseHeaders: JsonObject;
}

const CUSTOM_TYPE_ERROR = "pi-azure-openai-error-capture/error";
const DEFAULT_TAIL_COUNT = 5;
const MAX_TAIL_COUNT = 50;

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveLogPath(cwd: string): string {
  const configured = process.env.PI_AZURE_OPENAI_ERROR_CAPTURE_FILE?.trim();
  if (!configured) {
    return join(homedir(), ".pi", "logs", "azure-openai-errors.jsonl");
  }

  if (configured.startsWith("~/")) {
    return resolve(homedir(), configured.slice(2));
  }

  return resolve(cwd, configured);
}

function pickHeader(headers: Record<string, string>, key: string): string | undefined {
  return headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
}

function toJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function selectRequestMetadata(payload: unknown): JsonObject {
  const request = toJsonObject(payload);

  return {
    model: request.model,
    stream: request.stream,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    max_completion_tokens: request.max_completion_tokens,
    max_output_tokens: request.max_output_tokens,
    message_count: Array.isArray(request.messages) ? request.messages.length : undefined,
    input_count: Array.isArray(request.input) ? request.input.length : undefined,
    tool_count: Array.isArray(request.tools) ? request.tools.length : undefined,
  };
}

function asStringRecord(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      output[key.toLowerCase()] = raw;
      continue;
    }

    if (Array.isArray(raw)) {
      output[key.toLowerCase()] = raw.map((item) => String(item)).join(", ");
      continue;
    }

    if (raw !== undefined && raw !== null) {
      output[key.toLowerCase()] = String(raw);
    }
  }

  return output;
}

function isLikelyAzureResponse(headers: Record<string, string>): boolean {
  const keys = Object.keys(headers);
  return keys.some((key) => key.startsWith("x-ms-")) ||
    keys.includes("apim-request-id") ||
    keys.includes("x-azure-ref") ||
    keys.includes("x-azure-fdid");
}

function extractRequestId(headers: Record<string, string>): string | undefined {
  return pickHeader(headers, "x-ms-request-id") ??
    pickHeader(headers, "apim-request-id") ??
    pickHeader(headers, "x-request-id");
}

function writeJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function parseTailCount(raw: string | undefined): number {
  if (!raw) return DEFAULT_TAIL_COUNT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TAIL_COUNT;
  return Math.min(parsed, MAX_TAIL_COUNT);
}

function tailLog(path: string, count: number): CapturedProviderError[] {
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const selected = lines.slice(-count);
  const parsed: CapturedProviderError[] = [];

  for (const line of selected) {
    try {
      const candidate = JSON.parse(line) as CapturedProviderError;
      parsed.push(candidate);
    } catch {
      // Ignore malformed lines; the log stays append-only and robust.
    }
  }

  return parsed;
}

function formatTail(records: CapturedProviderError[]): string {
  if (records.length === 0) {
    return "No captured provider errors yet.";
  }

  return records
    .map((record, index) => {
      const headerLine = `#${index + 1} ${record.timestamp} status=${record.status} azure=${record.azure}`;
      const requestId = record.requestId ? `request_id=${record.requestId}` : "request_id=-";
      const retryAfter = record.retryAfter ? `retry_after=${record.retryAfter}` : "retry_after=-";
      return `${headerLine}\n${requestId} ${retryAfter}\n${JSON.stringify(record.request)}`;
    })
    .join("\n\n");
}

function parseCommandArgs(args: string): { action: string; value?: string } {
  const [actionRaw, valueRaw] = args.trim().split(/\s+/, 2);
  return {
    action: actionRaw?.toLowerCase() || "summary",
    value: valueRaw,
  };
}

function summarizeFromBranch(ctx: ExtensionContext): { count: number; latest?: CapturedProviderError } {
  let count = 0;
  let latest: CapturedProviderError | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE_ERROR) continue;
    count += 1;
    latest = entry.data as CapturedProviderError;
  }

  return { count, latest };
}

export default function azureOpenAIErrorCaptureExtension(pi: ExtensionAPI) {
  const pending: PendingRequest[] = [];
  const captureAllProviders = envBool("PI_AZURE_OPENAI_ERROR_CAPTURE_ALL", false);
  const notifyOnCapture = envBool("PI_AZURE_OPENAI_ERROR_CAPTURE_NOTIFY", true);

  pi.on("before_provider_request", (event) => {
    pending.push({
      timestamp: new Date().toISOString(),
      request: selectRequestMetadata(event.payload),
    });
  });

  pi.on("after_provider_response", (event, ctx) => {
    const request = pending.shift();
    if (event.status < 400) return;

    const headers = asStringRecord(event.headers);
    const azure = isLikelyAzureResponse(headers);

    if (!captureAllProviders && !azure) {
      return;
    }

    const logPath = resolveLogPath(ctx.cwd);
    const record: CapturedProviderError = {
      timestamp: request?.timestamp ?? new Date().toISOString(),
      status: event.status,
      requestId: extractRequestId(headers),
      retryAfter: pickHeader(headers, "retry-after"),
      azure,
      request: request?.request ?? {},
      responseHeaders: headers,
    };

    writeJsonLine(logPath, record);
    pi.appendEntry<CapturedProviderError>(CUSTOM_TYPE_ERROR, record);

    if (notifyOnCapture && ctx.hasUI) {
      const requestId = record.requestId ? ` request_id=${record.requestId}` : "";
      ctx.ui.notify(`Captured provider error: status=${record.status}${requestId}`, "warning");
    }
  });

  pi.registerCommand("azure-openai-errors", {
    description: "Inspect captured Azure OpenAI provider errors (summary, tail [n], path, clear)",
    getArgumentCompletions: (prefix) => {
      const options = ["summary", "tail", "path", "clear"];
      const normalized = prefix.toLowerCase();
      return options
        .filter((option) => option.startsWith(normalized))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args, ctx) => {
      const logPath = resolveLogPath(ctx.cwd);
      const parsed = parseCommandArgs(args);

      if (parsed.action === "path") {
        ctx.ui.notify(`Azure OpenAI error log path: ${logPath}`, "info");
        return;
      }

      if (parsed.action === "clear") {
        rmSync(logPath, { force: true });
        ctx.ui.notify("Cleared Azure OpenAI error log file.", "info");
        return;
      }

      if (parsed.action === "tail") {
        const count = parseTailCount(parsed.value);
        const records = tailLog(logPath, count);
        const text = formatTail(records);
        ctx.ui.setEditorText(text);
        ctx.ui.notify(`Loaded ${records.length} captured error(s) into editor.`, "info");
        return;
      }

      const branchSummary = summarizeFromBranch(ctx);
      const latestText = branchSummary.latest
        ? `latest status=${branchSummary.latest.status} at ${branchSummary.latest.timestamp}`
        : "no captured errors yet";

      ctx.ui.notify(
        `Captured errors in current session branch: ${branchSummary.count} (${latestText})`,
        "info",
      );
    },
  });
}
