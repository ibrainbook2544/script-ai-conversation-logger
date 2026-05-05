#!/usr/bin/env node
/*
 * Cross-platform Stop hook for local conversation logging.
 *
 * Compatible with both Claude Code hooks and Codex hooks.
 *
 * Reads the hook JSON from stdin, extracts transcript_path,
 * appends human-readable Markdown dialogue to log/YYYY-MM-DD.md,
 * and stores a per-transcript line offset so repeated Stop events do not duplicate logs.
 *
 * Failure mode: fail open. Logging should never trap the assistant in a loop.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function exitOk() {
  process.exit(0);
}

function readStdin() {
  return fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanModelName(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text.length > 120) return "";
  if (/^[.\-_/\\]+$/.test(text)) return "";
  if (/^(unknown|n\/a|null|none)$/i.test(text)) return "";
  return text;
}

function findModelName(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModelName(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (!isPlainObject(value)) return "";

  const modelKeys = new Set([
    "model",
    "modelName",
    "model_name",
    "modelSlug",
    "model_slug",
    "modelId",
    "model_id",
    "currentModel",
    "current_model",
  ]);

  for (const key of Object.keys(value)) {
    if (!modelKeys.has(key)) continue;
    const found = cleanModelName(value[key]);
    if (found) return found;
  }

  const ignoredPayloadKeys = new Set(["content", "text", "input", "arguments", "output", "result"]);
  for (const key of Object.keys(value)) {
    if (ignoredPayloadKeys.has(key)) continue;
    const found = findModelName(value[key], depth + 1);
    if (found) return found;
  }

  return "";
}

function fence(lang, text) {
  const body = String(text || "").replace(/\r\n?/g, "\n").replace(/```/g, "`\\`\\`");
  return ["```" + (lang || ""), body, "```"].join("\n");
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function looksLikeXml(text) {
  const trimmed = String(text || "").trim();
  return /^<[\w!?/]/.test(trimmed) && /<\/[\w:-]+>\s*$/.test(trimmed);
}

function formatTextBlock(text) {
  let normalized = String(text || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";
  // Clean IDE context tags to concise format
  normalized = normalized
    .replace(/<ide_opened_file>[^<]*?(?:opened|viewing) (?:the )?file (.*?) in the IDE[^<]*<\/ide_opened_file>/gi,
      "\u{1F4C2} *Opened: `$1`*")
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/g, "");
  if (!normalized.trim()) return "";
  if (looksLikeJson(normalized)) return fence("json", normalized.trim());
  if (looksLikeXml(normalized)) return fence("xml", normalized.trim());
  return normalized.trimEnd();
}

function formatToolUseSummary(name, input) {
  if (typeof input === "string") {
    return `- \u{1F527} **${name}**: ${input.slice(0, 200)}`;
  }
  const inp = isPlainObject(input) ? input : {};
  switch (name) {
    case "Bash": {
      const cmd = inp.command || inp.cmd || "";
      const desc = inp.description ? ` \u2014 ${inp.description}` : "";
      return `- \u{1F527} **Bash**: \`${cmd}\`${desc}`;
    }
    case "Read":
      return `- \u{1F4D6} **Read**: \`${inp.file_path || inp.path || ""}\``;
    case "Write": {
      const lineCount = String(inp.content || "").split("\n").length;
      return `- \u270F\uFE0F **Write**: \`${inp.file_path || inp.path || ""}\` (${lineCount} lines)`;
    }
    case "Edit":
      return `- \u270F\uFE0F **Edit**: \`${inp.file_path || inp.path || ""}\``;
    case "Glob":
      return `- \u{1F50D} **Glob**: \`${inp.pattern || ""}\` in \`${inp.path || ""}\``;
    case "Grep":
      return `- \u{1F50D} **Grep**: \`${inp.pattern || ""}\` in \`${inp.path || ""}\``;
    case "Skill":
      return `- \u26A1 **Skill**: ${inp.skill || ""}${inp.args ? " \u2014 " + inp.args : ""}`;
    case "WebSearch":
      return `- \u{1F310} **WebSearch**: ${inp.query || inp.search_query || ""}`;
    case "WebFetch":
      return `- \u{1F310} **WebFetch**: \`${inp.url || ""}\``;
    default: {
      const summary = JSON.stringify(input);
      return `- \u{1F527} **${name}**: ${summary.length > 200 ? summary.slice(0, 200) + "..." : summary}`;
    }
  }
}

function formatToolResultSummary(content) {
  const maxLines = 10;
  const maxChars = 500;
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (!text.trim()) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines && text.length <= maxChars) {
    return lines.map(l => `> ${l}`).join("\n");
  }
  const preview = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
  return preview.split("\n").map(l => `> ${l}`).join("\n") +
    `\n> *... (${lines.length} lines total)*`;
}

function formatObjectAsMarkdown(obj) {
  if (!isPlainObject(obj)) return asText(obj);

  if (
    typeof obj.text === "string" &&
    (obj.type === "text" || obj.type === "input_text" || obj.type === "output_text")
  ) {
    return formatTextBlock(obj.text);
  }

  // Thinking blocks: show first few lines, drop cryptographic signature
  if (obj.type === "thinking" && typeof obj.thinking === "string") {
    const thinkLines = obj.thinking.split("\n").filter(l => l.trim());
    const preview = thinkLines.slice(0, 3).join("\n> ");
    const truncated = thinkLines.length > 3;
    return `> \u{1F4AD} **Thinking**\n> ${preview}${truncated ? "\n> ..." : ""}`;
  }

  if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "function_call") {
    const name = obj.name || obj.tool || obj.function || obj.type;
    const input = obj.input ?? obj.arguments ?? obj.params ?? obj.content ?? {};
    return formatToolUseSummary(name, input);
  }

  if (obj.type === "tool_result" || obj.type === "function_result") {
    const raw = obj.content ?? obj.result ?? obj.output ?? obj.text ?? "";
    return formatToolResultSummary(raw);
  }

  if (typeof obj.content !== "undefined") {
    const inner = formatMarkdownContent(obj.content);
    const metadata = { ...obj };
    delete metadata.content;
    if (!inner) return asText(metadata);

    const metaKeys = Object.keys(metadata).filter(
      (key) => metadata[key] !== undefined && metadata[key] !== ""
    );
    if (metaKeys.length === 0) return inner;

    const metaSummary = metaKeys.map((key) => `- **${key}**: ${asText(metadata[key])}`).join("\n");
    return [metaSummary, "", inner].join("\n");
  }

  const keys = Object.keys(obj);
  if (keys.length <= 3 && keys.every((key) => typeof obj[key] !== "object")) {
    return keys.map((key) => `- **${key}**: ${asText(obj[key])}`).join("\n");
  }

  return fence("json", JSON.stringify(obj, null, 2));
}

function formatMarkdownContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return formatTextBlock(content);
  if (typeof content === "number" || typeof content === "boolean") return String(content);

  if (Array.isArray(content)) {
    return content
      .map((item) => formatMarkdownContent(item))
      .filter((item) => item && String(item).trim())
      .join("\n\n");
  }

  return formatObjectAsMarkdown(content);
}

function normalizedRenderedContent(content) {
  const text = formatMarkdownContent(content).replace(/\s+/g, " ").trim();
  return text;
}

function contentToSearchText(content) {
  return formatMarkdownContent(content)
    .replace(/\r\n?/g, "\n")
    .replace(/```(?:xml|json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractModelNameFromContent(content) {
  const text = contentToSearchText(content);
  if (!text) return "";
  if (!/<model_switch\b/i.test(text)) return "";

  const patterns = [
    /<model_switch\b[^>]*(?:to|model|name)=["']([^"']+)["']/i,
    /<model_switch\b[^>]*>[\s\S]*?<model(?:_name|_slug)?>([^<]+)<\/model(?:_name|_slug)?>/i,
    /<model_switch\b[^>]*>[\s\S]*?\b(?:current_model|current model|model_name|model_slug|model)\s*[:=]\s*["`']?([^\n<"`']{2,120})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const found = match ? cleanModelName(match[1]) : "";
    if (found) return found;
  }

  return "";
}

function isTitleGenerationPrompt(content) {
  const text = normalizedRenderedContent(content);
  return (
    /^Generate a title for this conversation:?$/i.test(text) ||
    /^User's request:\s*"""/i.test(text) && /Generate a title for this conversation:?\s*$/i.test(text)
  );
}

function isContextContent(content) {
  const text = normalizedRenderedContent(content);
  return /^(```xml\s*)?<(environment_context|skill|model_switch)\b/i.test(text);
}

function isNoiseContent(content) {
  const text = normalizedRenderedContent(content);
  return (
    isTitleGenerationPrompt(content) ||
    /^Initialize .{0,80}conversation/i.test(text)
  );
}

function contentToTitle(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textItem = content.find(
      (item) =>
        item &&
        (item.type === "text" || item.type === "input_text" || item.type === "output_text") &&
        item.text
    );
    return textItem ? asText(textItem.text) : "";
  }
  return asText(content);
}

function cleanTitle(text) {
  const candidate = String(text || "")
    .replace(/<[^>\n]+>[\s\S]*?<\/[^>\n]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find(
      (line) =>
        !/^generate a title/i.test(line) &&
        !/^user's request:/i.test(line) &&
        !/^<environment_context>/i.test(line)
    );

  return (candidate || "Conversation Transcript Update").replace(/\s+/g, " ").slice(0, 80);
}

function localTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return {
    day: `${year}-${month}-${day}`,
    stamp: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  };
}

function formatMessageTimestamp(value) {
  if (!value) return "";

  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value));

  if (Number.isNaN(date.getTime())) return String(value);
  return localTimestamp(date).stamp;
}

function loadConfig(vaultRoot) {
  const configPath = path.join(vaultRoot, ".script", "conversation-logger.config.json");
  const config = {
    outputDir: "log",
    header: "",
  };

  if (!fs.existsSync(configPath)) return config;

  try {
    const loaded = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (loaded && typeof loaded.outputDir === "string" && loaded.outputDir.trim()) {
      config.outputDir = loaded.outputDir.trim();
    }
    if (loaded && typeof loaded.header === "string") {
      config.header = loaded.header;
    }
  } catch {
    // Invalid config should not block logging. Fall back to the default path.
  }

  return config;
}

function renderConfigTemplate(text, values) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

function buildNewLogEntry(config, day, block) {
  const header = renderConfigTemplate(config.header, { day }).replace(/\r\n?/g, "\n").trimEnd();
  const parts = [];

  if (header) parts.push(header);
  parts.push(block.trimEnd());

  return `${parts.join("\n\n")}\n`;
}

function resolveOutputDir(vaultRoot, outputDir) {
  if (path.isAbsolute(outputDir)) return outputDir;
  return path.join(vaultRoot, outputDir);
}

function normalizeWindowsLongPath(inputPath) {
  const raw = String(inputPath || "");
  if (process.platform !== "win32") return raw;
  if (raw.startsWith("\\\\?\\UNC\\")) return `\\\\${raw.slice(8)}`;
  if (raw.startsWith("\\\\?\\")) return raw.slice(4);
  return raw;
}

function canonicalPathForState(inputPath) {
  const normalized = normalizeWindowsLongPath(inputPath);
  try {
    return fs.realpathSync(normalized);
  } catch {
    return path.resolve(normalized);
  }
}

function extractModelName(event) {
  return findModelName(event) || extractModelNameFromContent(event && event.content);
}

function extractTranscriptMessage(event) {
  if (!event || typeof event !== "object") return null;
  const model = extractModelName(event);

  // Claude Code transcript shape:
  // {"message":{"role":"user|assistant","content":"..."}, ...}
  if (event.message && typeof event.message === "object") {
    const role = event.message.role || event.type || "event";
    if (role !== "user" && role !== "assistant") return null;
    return {
      role,
      timestamp: event.timestamp || event.created_at || "",
      content: event.message.content ?? event.content ?? "",
      model,
    };
  }

  // Codex transcript shape:
  // {"type":"response_item","payload":{"type":"message","role":"user|assistant","content":[...]}}
  if (event.type === "response_item" && event.payload && event.payload.type === "message") {
    const role = event.payload.role || "event";
    if (role !== "user" && role !== "assistant") return null;
    return {
      role,
      timestamp: event.timestamp || event.created_at || "",
      content: event.payload.content ?? [],
      model,
    };
  }

  // Codex user event convenience shape:
  // {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
  if (event.type === "event_msg" && event.payload && event.payload.type === "user_message") {
    return {
      role: "user",
      timestamp: event.timestamp || event.created_at || "",
      content: event.payload.message || "",
      model,
    };
  }

  if (event.type === "event_msg" && event.payload && event.payload.type === "agent_message") {
    return {
      role: "assistant",
      timestamp: event.timestamp || event.created_at || "",
      content: event.payload.text || event.payload.message || "",
      model,
    };
  }

  return null;
}

function transcriptLineToMessage(rawLine) {
  rawLine = String(rawLine || "").replace(/^\uFEFF/, "");
  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return null;
  }

  const message = extractTranscriptMessage(event);
  if (!message) return null;
  return message;
}

function messageToEntry(message, currentModel = "") {
  const model = cleanModelName(message.model) || cleanModelName(currentModel);
  const roleLabel = message.role === "user" ? "[User]" : `[${model || "AI"}]`;
  if (isNoiseContent(message.content)) return null;
  const body = formatMarkdownContent(message.content ?? "").trim();
  if (!body) return null;

  const messageTimestamp = message.timestamp ? ` - ${formatMessageTimestamp(message.timestamp)}` : "";
  return [`### ${roleLabel}${messageTimestamp}`, "", body, ""].join("\n");
}

function transcriptLineToEntry(rawLine) {
  const message = transcriptLineToMessage(rawLine);
  return message ? messageToEntry(message) : null;
}

function parseTranscriptLine(rawLine) {
  rawLine = String(rawLine || "").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(rawLine);
  } catch {
    return null;
  }
}

function formatFileHistoryEntry(event) {
  if (!event.snapshot) return null;
  const backups = event.snapshot.trackedFileBackups;
  if (!backups || !isPlainObject(backups)) return null;
  const files = Object.keys(backups);
  if (files.length === 0) return null;
  const fileList = files.map(f => `\`${f}\``).join(", ");
  return `> \u{1F4C1} **Files modified**: ${fileList}\n`;
}

function extractEntriesWithModels(lines) {
  const entries = [];
  let currentModel = "";

  for (const line of lines) {
    const event = parseTranscriptLine(line);
    if (!event) continue;

    const eventModel = extractModelName(event);
    if (eventModel) currentModel = eventModel;

    // Handle file-history-snapshot: list modified files
    if (event.type === "file-history-snapshot") {
      const entry = formatFileHistoryEntry(event);
      if (entry) entries.push(entry);
      continue;
    }

    const message = extractTranscriptMessage(event);
    if (!message) continue;

    const contentModel = extractModelNameFromContent(message.content);
    if (contentModel) currentModel = contentModel;
    if (!message.model && currentModel) message.model = currentModel;

    const entry = messageToEntry(message, currentModel);
    if (typeof entry === "string" && entry.trim()) entries.push(entry);
  }

  return entries;
}

function dedupeAdjacentEntries(entries) {
  const deduped = [];
  let previousSignature = "";
  for (const entry of entries) {
    const current = String(entry || "").trim();
    if (!current) continue;
    const currentSignature = entrySignature(current);
    if (currentSignature && currentSignature === previousSignature) continue;
    deduped.push(entry);
    previousSignature = currentSignature;
  }
  return deduped;
}

function entrySignature(entry) {
  return String(entry || "")
    .replace(/\r\n?/g, "\n")
    .trim()
    // Codex/Claude can emit the same message twice with timestamps that differ
    // by only a millisecond.  For dedupe purposes the timestamp is metadata, not
    // content, so compare role + body only.
    .replace(/^### ([^\n]+?)(?: - .*)?$/m, "### $1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function buildConversationBlock(stamp, title, newLines) {
  const messages = newLines
    .map((line) => transcriptLineToMessage(line))
    .filter(Boolean);

  const hasTitlePrompt = messages.some((message) => isTitleGenerationPrompt(message.content));
  const hasMeaningfulUserMessage = messages.some(
    (message) =>
      message.role === "user" &&
      !isNoiseContent(message.content) &&
      !isContextContent(message.content)
  );
  if (hasTitlePrompt && !hasMeaningfulUserMessage) return null;

  const entries = extractEntriesWithModels(newLines);
  const dedupedEntries = dedupeAdjacentEntries(entries);

  if (dedupedEntries.length === 0) return null;

  return [`## ${stamp} - ${title}`, "", ...dedupedEntries, "---", ""].join("\n");
}

function appendConversationToExistingLog(logFile, block) {
  fs.appendFileSync(logFile, `\n${block}`, "utf8");
}

try {
  const input = readStdin();
  const hook = JSON.parse(input || "{}");
  const scriptDir = __dirname;
  const vaultRoot = path.resolve(scriptDir, "..");
  const transcriptPath = hook.transcript_path || hook.transcriptPath || "";
  const transcriptExists = Boolean(transcriptPath) && fs.existsSync(transcriptPath);
  if (!transcriptPath || !transcriptExists) exitOk();

  const config = loadConfig(vaultRoot);
  const logDir = resolveOutputDir(vaultRoot, config.outputDir);
  const stateDir = path.join(vaultRoot, ".script", ".conversation-logger-state");
  ensureDir(logDir);
  ensureDir(stateDir);

  const transcriptRealPath = canonicalPathForState(transcriptPath);
  const key = crypto.createHash("sha256").update(transcriptRealPath).digest("hex").slice(0, 24);
  const stateFile = path.join(stateDir, `${key}.state`);

  let lastLine = 0;
  if (fs.existsSync(stateFile)) {
    const parsed = Number.parseInt(fs.readFileSync(stateFile, "utf8").trim() || "0", 10);
    if (Number.isFinite(parsed)) lastLine = parsed;
  }

  const text = fs.readFileSync(transcriptPath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const newLines = lines.slice(lastLine);

  if (newLines.length === 0) {
    fs.writeFileSync(stateFile, String(totalLines), "utf8");
    exitOk();
  }

  const { day, stamp } = localTimestamp(new Date());
  const logFile = path.join(logDir, `${day}.md`);

  let title = "Conversation Transcript Update";
  // Prefer ai-title event for conversation title
  for (const line of newLines) {
    const event = parseTranscriptLine(line);
    if (event && event.type === "ai-title" && event.aiTitle) {
      title = cleanTitle(event.aiTitle);
      break;
    }
  }
  // Fall back to extracting title from message content
  if (title === "Conversation Transcript Update") {
    for (let i = newLines.length - 1; i >= 0; i -= 1) {
      try {
        const event = JSON.parse(newLines[i]);
        const message = extractTranscriptMessage(event);
        if (!message) continue;
        const candidate = cleanTitle(contentToTitle(message.content));
        if (candidate) {
          title = candidate;
          break;
        }
      } catch {
        // Keep looking for a parseable line.
      }
    }
  }

  const block = buildConversationBlock(stamp, title, newLines);
  if (!block) {
    fs.writeFileSync(stateFile, String(totalLines), "utf8");
    exitOk();
  }

  if (fs.existsSync(logFile)) {
    appendConversationToExistingLog(logFile, block);
  } else {
    const entry = buildNewLogEntry(config, day, block);
    fs.writeFileSync(logFile, entry, "utf8");
  }
  fs.writeFileSync(stateFile, String(totalLines), "utf8");
} catch {
  exitOk();
}

exitOk();
