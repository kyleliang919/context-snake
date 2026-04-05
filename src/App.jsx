import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════
   LOCAL STORAGE PERSISTENCE
   ═══════════════════════════════════════════════════════════ */
const STORAGE_PREFIX = "ctx_snake_";
const Storage = {
  saveApiConfig(c) { try { localStorage.setItem(STORAGE_PREFIX + "api", JSON.stringify(c)); } catch {} },
  loadApiConfig() { try { return migrateStoredApiConfig(JSON.parse(localStorage.getItem(STORAGE_PREFIX + "api")) || {}); } catch { return migrateStoredApiConfig({}); } },
  saveMap(name, state) {
    try {
      const data = {
        bubbles: state.bubbles.filter(b => !b.isOnboarding).map(b => ({ id: b.id, x: b.x, y: b.y, items: b.items, readers: b.readers || [],
          autoSeekable: b.autoSeekable, fileName: b.fileName, fileSize: b.fileSize, fileType: b.fileType,
          isMemory: b.isMemory, isResult: b.isResult, resultTitle: b.resultTitle, resultSources: b.resultSources,
          sourceUrl: b.sourceUrl, sourceTitle: b.sourceTitle, sourceSnippet: b.sourceSnippet, sourceDomain: b.sourceDomain,
          sourceMeta: b.sourceMeta,
          compressedFrom: b.compressedFrom, humanRead: b.humanRead, createdAt: b.createdAt,
          settled: b.settled, resultParentId: b.resultParentId,
        })),
        snakes: state.snakes.filter(sn => sn.alive).map(sn => ({
          id: sn.id, name: sn.name, colorIdx: sn.colorIdx,
          headX: sn.segments[0].x, headY: sn.segments[0].y,
          context: sn.context, task: sn.task,
          autoSeek: sn.autoSeek,
          model: sn.model, apiKey: sn.apiKey, apiBase: sn.apiBase,
          parentId: sn.parentId, childIds: sn.childIds, depth: sn.depth,
        })),
        camera: state.camera, savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_PREFIX + "map_" + name, JSON.stringify(data));
      const list = Storage.listMaps();
      if (!list.includes(name)) { list.push(name); localStorage.setItem(STORAGE_PREFIX + "maps", JSON.stringify(list)); }
    } catch (e) { console.error("Save failed:", e); }
  },
  loadMap(name) { try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + "map_" + name)); } catch { return null; } },
  listMaps() { try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + "maps")) || []; } catch { return []; } },
  deleteMap(name) { try { localStorage.removeItem(STORAGE_PREFIX + "map_" + name); const l = Storage.listMaps().filter(n => n !== name); localStorage.setItem(STORAGE_PREFIX + "maps", JSON.stringify(l)); } catch {} },
  saveLastMap(n) { try { localStorage.setItem(STORAGE_PREFIX + "last", n); } catch {} },
  loadLastMap() { try { return localStorage.getItem(STORAGE_PREFIX + "last") || ""; } catch { return ""; } },
};

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */
const LOCAL_PROXY_ORIGIN = "http://localhost:8010";
const LOCAL_DEV_FRONTEND_PORTS = new Set(["3000", "4173", "5173"]);
function getRuntimeProxyOrigin() {
  if (typeof window === "undefined") return LOCAL_PROXY_ORIGIN;
  const origin = String(window.location?.origin || "").trim();
  const hostname = String(window.location?.hostname || "").trim().toLowerCase();
  const port = String(window.location?.port || "").trim();
  if (!origin || origin === "null") return LOCAL_PROXY_ORIGIN;
  if ((hostname === "localhost" || hostname === "127.0.0.1") && LOCAL_DEV_FRONTEND_PORTS.has(port)) {
    return LOCAL_PROXY_ORIGIN;
  }
  return origin;
}
function getProviderApiBase(provider = "openai") {
  return `${getRuntimeProxyOrigin()}/${provider}`;
}

const MAP_W = 5000, MAP_H = 4000;
const SEG_R = 6, SEG_GAP = 11, SNAKE_SPEED = 1.8;
const READ_DIST = 44, MERGE_DIST = 20, LEASH_RADIUS = 200;
const BASE_SEGMENTS = 6;
const BUBBLE_MERGE_DRAG_DIST = 38;
const NODE_RADIUS = 24;
const MAX_CONTEXT = 18;
const COMPRESS_BATCH = 8;
const PERCEPTION_RADIUS = 600; // how far unleashed snakes can "see"
const SCENT_SPEED_MULT = 3.0; // speed boost when following scent trail
const SCENT_FADE_TIME = 400; // ticks before scent trails fade
const MAX_ALIVE_SNAKES = 6; // autonomous spawn limit; manual user-created snakes are unrestricted
const MAX_SPAWN_DEPTH = 2; // root=0, children=1, grandchildren=2, no deeper
const SUBAGENT_IDLE_TIMEOUT = 20000; // 30s idle → auto-complete
const SUBAGENT_MAX_THINKS = 4; // max autonomous think cycles per sub-agent
const REQUIRE_PERSONAL_API_KEY = true;
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_SEARCH_MODEL = "gpt-4o-mini-search-preview";
const DEFAULT_API_BASE = getProviderApiBase("openai");
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_SEARCH_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
const DEFAULT_GOOGLE_FAST_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_GOOGLE_SEARCH_MODEL = "gemini-2.5-flash";
const LEGACY_DEFAULT_MODEL = "claude-sonnet-4-20250514";
const LEGACY_DEFAULT_BASES = new Set([
  "",
  "https://api.anthropic.com",
  "http://localhost:8010/anthropic",
  getProviderApiBase("anthropic"),
]);
const ANTHROPIC_WEB_SEARCH_MODELS = new Set([
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
]);
const GOOGLE_WEB_SEARCH_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]);

function migrateStoredApiConfig(config = {}) {
  const model = String(config.model || "").trim();
  const apiBase = String(config.apiBase || "").trim().replace(/\/+$/, "");
  const hasExplicitAnthropicChoice = model && model !== LEGACY_DEFAULT_MODEL;
  if (!hasExplicitAnthropicChoice && (model === "" || model === LEGACY_DEFAULT_MODEL) && LEGACY_DEFAULT_BASES.has(apiBase)) {
    return { ...config, model: DEFAULT_MODEL, apiBase: DEFAULT_API_BASE };
  }
  return config;
}

const MODEL_PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    apiBase: getProviderApiBase("openai"),
    defaultModel: DEFAULT_MODEL,
    models: [
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
      { value: "gpt-5.2", label: "GPT-5.2" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    ],
  },
  anthropic: {
    label: "Anthropic",
    apiBase: getProviderApiBase("anthropic"),
    defaultModel: LEGACY_DEFAULT_MODEL,
    models: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  google: {
    label: "Google Gemini",
    apiBase: getProviderApiBase("google"),
    defaultModel: DEFAULT_GOOGLE_MODEL,
    models: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
};

function getProviderPreset(provider = "openai") {
  return MODEL_PROVIDER_PRESETS[provider] || MODEL_PROVIDER_PRESETS.openai;
}

const PROVIDER_KEY_HELP = {
  openai: {
    setupLabel: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs/quickstart",
    consoleUrl: "https://platform.openai.com/",
    placeholder: "sk-proj-...",
    shortHelp: "Create a project API key in the OpenAI Platform, then paste it here.",
  },
  anthropic: {
    setupLabel: "Anthropic",
    keyUrl: "https://console.anthropic.com/",
    docsUrl: "https://docs.anthropic.com/en/api/overview",
    consoleUrl: "https://console.anthropic.com/",
    placeholder: "sk-ant-...",
    shortHelp: "Open the Anthropic Console, create an API key in account settings, then paste it here.",
  },
  google: {
    setupLabel: "Google Gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
    consoleUrl: "https://aistudio.google.com/",
    placeholder: "AIza...",
    shortHelp: "Create a Gemini API key in Google AI Studio, then paste it here for BYOK mode.",
  },
};

function getProviderKeyHelp(provider = "openai") {
  return PROVIDER_KEY_HELP[provider] || PROVIDER_KEY_HELP.openai;
}

const PALETTES = [
  { body: "#22d65b", head: "#5fffaa", glow: "rgba(34,214,91,0.4)", name: "α" },
  { body: "#e6a020", head: "#ffe066", glow: "rgba(230,180,40,0.4)", name: "β" },
  { body: "#e04888", head: "#ff80b5", glow: "rgba(224,72,136,0.4)", name: "γ" },
  { body: "#2299d6", head: "#66ccff", glow: "rgba(34,153,214,0.4)", name: "δ" },
  { body: "#9955dd", head: "#cc88ff", glow: "rgba(153,85,221,0.4)", name: "ε" },
  { body: "#e06030", head: "#ff9966", glow: "rgba(224,96,48,0.4)", name: "ζ" },
];

/* ── file type system ── */
const FILE_TYPES = {
  py:   { icon: "🐍", color: "#3572A5", label: "Python" },
  js:   { icon: "JS", color: "#f1e05a", label: "JavaScript" },
  ts:   { icon: "TS", color: "#3178c6", label: "TypeScript" },
  jsx:  { icon: "⚛", color: "#61dafb", label: "React" },
  tsx:  { icon: "⚛", color: "#3178c6", label: "React TS" },
  rs:   { icon: "🦀", color: "#dea584", label: "Rust" },
  go:   { icon: "Go", color: "#00ADD8", label: "Go" },
  rb:   { icon: "💎", color: "#CC342D", label: "Ruby" },
  java: { icon: "☕", color: "#b07219", label: "Java" },
  cpp:  { icon: "C+", color: "#f34b7d", label: "C++" },
  c:    { icon: "C", color: "#555555", label: "C" },
  html: { icon: "<>", color: "#e34c26", label: "HTML" },
  css:  { icon: "#", color: "#563d7c", label: "CSS" },
  json: { icon: "{}", color: "#a0a0a0", label: "JSON" },
  md:   { icon: "M↓", color: "#888888", label: "Markdown" },
  txt:  { icon: "Aa", color: "#777777", label: "Text" },
  yml:  { icon: "⚙", color: "#cb171e", label: "YAML" },
  yaml: { icon: "⚙", color: "#cb171e", label: "YAML" },
  toml: { icon: "⚙", color: "#9c4221", label: "TOML" },
  sh:   { icon: "$_", color: "#89e051", label: "Shell" },
  sql:  { icon: "db", color: "#e38c00", label: "SQL" },
  pdf:  { icon: "📕", color: "#e04040", label: "PDF" },
  png:  { icon: "🖼", color: "#a060cc", label: "Image" },
  jpg:  { icon: "🖼", color: "#a060cc", label: "Image" },
  jpeg: { icon: "🖼", color: "#a060cc", label: "Image" },
  gif:  { icon: "🖼", color: "#a060cc", label: "Image" },
  svg:  { icon: "◇", color: "#ff9900", label: "SVG" },
  mp4:  { icon: "▶", color: "#ff4444", label: "Video" },
  mov:  { icon: "▶", color: "#ff4444", label: "Video" },
  csv:  { icon: "⊞", color: "#237346", label: "CSV" },
};

const CATS = {
  question: { icon: "?",  bg: "#0c2a3a", border: "#1a5577", color: "#5bc0eb" },
  answer:   { icon: "→",  bg: "#152a0f", border: "#3a6622", color: "#9bc53d" },
  idea:     { icon: "✦",  bg: "#2a2508", border: "#665518", color: "#fde74c" },
  fact:     { icon: "•",  bg: "#1a1430", border: "#3a2866", color: "#c3a6ff" },
  action:   { icon: "⚡", bg: "#0a2a28", border: "#186660", color: "#5ce0d8" },
  code:     { icon: "<>", bg: "#0a2a20", border: "#186648", color: "#80ffdb" },
  edit:     { icon: "✎",  bg: "#2a1a0a", border: "#664818", color: "#ffbb66" },
  analysis: { icon: "◎",  bg: "#200a2a", border: "#481866", color: "#e0aaff" },
  plan:     { icon: "▤",  bg: "#0a1a2a", border: "#183866", color: "#66aaff" },
  file:     { icon: "📄", bg: "#1a1a10", border: "#444420", color: "#cccc88" },
  memory:   { icon: "🧠", bg: "#1a0a20", border: "#441866", color: "#dd88ff" },
  error:    { icon: "✕",  bg: "#2a0a0a", border: "#661818", color: "#ff6666" },
  source:   { icon: "🔗", bg: "#0a1520", border: "#183048", color: "#55aadd" },
  result:   { icon: "★",  bg: "#082008", border: "#186618", color: "#66ff88" },
  summary:  { icon: "📋", bg: "#18180a", border: "#484818", color: "#ddcc55" },
  default:  { icon: "○",  bg: "#141420", border: "#2a2a44", color: "#888899" },
};

function uid() { return Math.random().toString(36).slice(2, 10); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function hasPersonalApiKey(config = {}) { return !!String(config?.apiKey || "").trim(); }
function createDraftSessionName() { return `new session-${uid().slice(0, 4)}`; }
function normalizeSessionName(name = "") {
  return String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
function isPlaceholderSessionName(name = "") {
  const value = normalizeSessionName(name).toLowerCase();
  return !value || /^untitled(?:-[a-z0-9]+)?$/.test(value) || /^new session(?:-[a-z0-9]+)?$/.test(value);
}

function getFileExt(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}
function getFileType(name) {
  return FILE_TYPES[getFileExt(name)] || { icon: "📄", color: "#888", label: "File" };
}
function isImageFile(name) { return ["png","jpg","jpeg","gif","svg","webp"].includes(getFileExt(name)); }
function isTextFile(name) {
  return ["py","js","ts","jsx","tsx","rs","go","rb","java","cpp","c","html","css","json","md","txt","yml","yaml","toml","sh","sql","csv","xml","env","gitignore","dockerfile","makefile"].includes(getFileExt(name));
}

function classifyUser(text) {
  const t = text.toLowerCase();
  if (/\?|^(how|what|why|who|when|where|which|is |are |do |does |can )/.test(t)) return "question";
  if (/\b(idea|maybe|could|what if)\b/.test(t)) return "idea";
  if (/\b(make|create|build|do|run|write|code|implement|fix|refactor|add)\b/.test(t)) return "action";
  return "default";
}

/* ═══════════════════════════════════════════════════════════
   LLM
   ═══════════════════════════════════════════════════════════ */
/* ── rate limiter ── */
/* ═══════════════════════════════════════════════════════════
   AGENT LAYER — Clean rewrite
   Architecture: LLMClient → ToolRegistry → ResearchEngine
   Based on patterns from Tavily EDR, MCP-Agent, ReAct loop
   ═══════════════════════════════════════════════════════════ */

// ── Activity Log ──
const _activityLog = [];
function _log(agent, action, detail = "", level = "info") {
  const entry = { time: Date.now(), agent: agent || "system", action, detail: String(detail).slice(0, 800), level };
  _activityLog.push(entry);
  if (_activityLog.length > 300) _activityLog.shift();
  if (level === "error") console.error(`[${entry.agent}] ${action}: ${detail}`);
  else console.log(`[${entry.agent}] ${action}${detail ? ": " + String(detail).slice(0, 120) : ""}`);
}

// ═══════════════════════════════════════════════════════════
// LLM CLIENT — single reliable API caller
// Features: Promise.race timeout, retry with backoff, rate limit,
//           full logging at every step, Anthropic + OpenAI support
// ═══════════════════════════════════════════════════════════
const _rateLimiter = { lastCall: 0, minGap: 400 };
const LLM_TIMEOUT = 30000;
const _webSearchToolWorks = new Map(); // key: provider|base|model -> true/false
const _sourcePreviewCache = new Map(); // key: source URL -> Promise<metadata|null>

function normalizeApiBase(apiBase = DEFAULT_API_BASE) {
  return String(apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, "") || DEFAULT_API_BASE;
}

function detectProvider(model = DEFAULT_MODEL, apiBase = DEFAULT_API_BASE) {
  const base = normalizeApiBase(apiBase).toLowerCase();
  const normalizedModel = String(model || "").trim().toLowerCase();
  if (base.includes("openai") || base.includes("api.openai.com") || normalizedModel.startsWith("gpt") || normalizedModel.startsWith("o")) {
    return "openai";
  }
  if (base.includes("google") || base.includes("generativelanguage.googleapis.com") || normalizedModel.startsWith("gemini")) {
    return "google";
  }
  return "anthropic";
}

function getSnakeProvider(sn) {
  return detectProvider(sn?.model, sn?.apiBase);
}

function getSnakeProviderLabel(sn) {
  return getProviderPreset(getSnakeProvider(sn)).label;
}

function joinApiPath(apiBase, path) {
  const base = normalizeApiBase(apiBase);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) return `${base.slice(0, -3)}${normalizedPath}`;
  return `${base}${normalizedPath}`;
}

function resolveLLMConfig(config = {}) {
  const model = String(config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const apiKey = String(config.apiKey || "").trim();
  const apiBase = normalizeApiBase(config.apiBase || DEFAULT_API_BASE);
  const provider = detectProvider(model, apiBase);
  return {
    model,
    maxTokens: config.maxTokens || 2048,
    apiKey,
    apiBase,
    provider,
    isOpenAI: provider === "openai",
    isAnthropic: provider === "anthropic",
    isGoogle: provider === "google",
    hasCustomBase: apiBase !== DEFAULT_API_BASE,
  };
}

function buildOpenAIHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function buildAnthropicHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

function buildGoogleHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  return headers;
}

function getWebSearchCacheKey({ provider, apiBase, model }) {
  return `${provider}|${normalizeApiBase(apiBase)}|${String(model || "").trim()}`;
}

function shouldDisableWebSearch(status, body = "") {
  if (status === 404) return true;
  if (status >= 500 || status === 401 || status === 403 || status === 429) return false;
  return /(web[_ -]?search|tool).*(unsupported|unavailable|unknown|invalid)|unsupported.*tool/i.test(body);
}

function extractOpenAITextContent(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return part?.text?.value || part?.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractOpenAISources(message, text = "") {
  const seen = new Set();
  const sources = [];
  const addSource = (url, title = "", snippet = "") => {
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl || seen.has(cleanUrl)) return;
    seen.add(cleanUrl);
    sources.push({ title: String(title || "").trim(), url: cleanUrl, snippet: String(snippet || "").trim(), fullContent: "" });
  };

  const visitAnnotation = (annotation, fallbackText = "") => {
    if (!annotation || typeof annotation !== "object") return;
    const url = annotation.url || annotation?.url_citation?.url || annotation?.source?.url || annotation?.webpage?.url;
    const title = annotation.title || annotation?.url_citation?.title || annotation?.source?.title || annotation?.webpage?.title || "";
    addSource(url, title, fallbackText);
  };

  for (const annotation of (message?.annotations || [])) visitAnnotation(annotation);
  for (const part of (Array.isArray(message?.content) ? message.content : [])) {
    const fallbackText = part?.text || part?.text?.value || "";
    for (const annotation of (part?.annotations || [])) visitAnnotation(annotation, fallbackText);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s\])"',]+/g)) addSource(match[0]);
  return sources;
}

function getMessageTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return part?.text?.value || part?.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content?.text?.value || content?.text || "";
}

function buildGeminiContents(messages = []) {
  const contents = [];
  for (const msg of messages || []) {
    const text = String(getMessageTextContent(msg?.content) || "").trim();
    if (!text) continue;
    const role = msg?.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Continue." }] }];
}

function buildGeminiRequestBody(messages, systemPrompt, maxTokens, extra = {}) {
  const body = {
    contents: buildGeminiContents(messages),
    generationConfig: { maxOutputTokens: maxTokens },
    ...extra,
  };
  if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };
  return body;
}

function extractGeminiTextContent(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts.map(part => part?.text || "").filter(Boolean).join("\n");
    if (text.trim()) return text;
  }
  return "";
}

function describeGeminiResponseIssue(data) {
  const promptBlock = data?.promptFeedback?.blockReason || data?.promptFeedback?.block_reason;
  if (promptBlock) return `Gemini blocked the prompt (${promptBlock})`;
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const finishReason = candidate?.finishReason || candidate?.finish_reason;
  const finishMessage = candidate?.finishMessage || candidate?.finish_message;
  if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    return finishMessage ? `Gemini finished with ${finishReason}: ${finishMessage}` : `Gemini finished with ${finishReason}`;
  }
  return "";
}

function extractGeminiSources(candidate, text = "") {
  const grounding = candidate?.groundingMetadata || candidate?.grounding_metadata || {};
  const supports = Array.isArray(grounding?.groundingSupports || grounding?.grounding_supports)
    ? (grounding.groundingSupports || grounding.grounding_supports)
    : [];
  const chunks = Array.isArray(grounding?.groundingChunks || grounding?.grounding_chunks)
    ? (grounding.groundingChunks || grounding.grounding_chunks)
    : [];
  const snippetMap = new Map();
  for (const support of supports) {
    const indices = Array.isArray(support?.groundingChunkIndices || support?.grounding_chunk_indices)
      ? (support.groundingChunkIndices || support.grounding_chunk_indices)
      : [];
    const segment = support?.segment || {};
    const fallbackText = typeof segment?.startIndex === "number" && typeof segment?.endIndex === "number" && text
      ? text.slice(segment.startIndex, segment.endIndex)
      : "";
    const segmentText = String(segment?.text || fallbackText || "").trim();
    for (const idx of indices) {
      if (!segmentText) continue;
      if (!snippetMap.has(idx)) snippetMap.set(idx, []);
      snippetMap.get(idx).push(segmentText);
    }
  }

  const seen = new Set();
  const sources = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx] || {};
    const web = chunk.web || {};
    const url = String(web.uri || web.url || chunk.uri || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippets = Array.from(new Set(snippetMap.get(idx) || [])).filter(Boolean);
    sources.push({
      title: String(web.title || chunk.title || "").trim(),
      url,
      snippet: snippets.join(" ").slice(0, 300),
      fullContent: "",
    });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s\])"',]+/g)) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({ title: "", url, snippet: "", fullContent: "" });
    }
  }
  return sources;
}

async function llmCall(messages, systemPrompt, config = {}) {
  if (REQUIRE_PERSONAL_API_KEY && !hasPersonalApiKey(config)) {
    const error = getMissingKeyMessage(config);
    _log("llm", "missing-key", error, "error");
    return { ok: false, error };
  }

  // Rate limit
  const gap = _rateLimiter.minGap - (Date.now() - _rateLimiter.lastCall);
  if (gap > 0) { _log("llm", "rate-wait", `${gap}ms`); await new Promise(r => setTimeout(r, gap)); }
  _rateLimiter.lastCall = Date.now();

  const { model, maxTokens, apiKey, apiBase, isOpenAI, isAnthropic, isGoogle, hasCustomBase } = resolveLLMConfig(config);
  const ctxLen = messages.reduce((n, m) => n + (m.content?.length || 0), 0);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    let requestUrl = "";
    try {
      _log("llm", "call", `${model} | ${ctxLen}c ctx | attempt ${attempt}/3 | sys: "${systemPrompt.slice(0, 50).replace(/\n/g, " ")}…"`);

      // Build fetch request
      let fetchP;
      if (isOpenAI) {
        requestUrl = joinApiPath(apiBase, "/v1/chat/completions");
        const openAIBody = {
          model,
          max_completion_tokens: maxTokens,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
        };
        fetchP = fetch(requestUrl, {
          method: "POST",
          headers: buildOpenAIHeaders(apiKey),
          body: JSON.stringify(openAIBody),
        });
      } else if (isAnthropic) {
        const url = hasCustomBase ? joinApiPath(apiBase, "/v1/messages") : "https://api.anthropic.com/v1/messages";
        requestUrl = url;
        const headers = buildAnthropicHeaders(apiKey);
        fetchP = fetch(url, {
          method: "POST", headers,
          body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
        });
      } else if (isGoogle) {
        requestUrl = joinApiPath(apiBase, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
        fetchP = fetch(requestUrl, {
          method: "POST",
          headers: buildGoogleHeaders(apiKey),
          body: JSON.stringify(buildGeminiRequestBody(messages, systemPrompt, maxTokens)),
        });
      } else {
        return { ok: false, error: `Unsupported provider: ${config.provider || "unknown"}` };
      }

      // Promise.race timeout — catches CORS hangs, network drops, everything
      const res = await Promise.race([
        fetchP,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${LLM_TIMEOUT/1000}s — check provider selection, API key, and local proxy at http://localhost:8010`)), LLM_TIMEOUT)),
      ]);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (res.status === 429) {
        const wait = attempt * 5000;
        _log("llm", "rate-limited", `${elapsed}s | retry in ${wait/1000}s`, "warn");
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (res.status === 529 || res.status === 503) {
        _log("llm", "overloaded", `${res.status} | ${elapsed}s | retry in 5s`, "warn");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        _log("llm", "http-error", `${res.status} | ${elapsed}s | ${body.slice(0, 300)}`, "error");
        if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 100)}` };
      }

      const data = await res.json();
      const text = isOpenAI
        ? extractOpenAITextContent(data.choices?.[0]?.message)
        : isAnthropic
        ? (data.content?.map(c => c.text || "").join("") || "")
        : extractGeminiTextContent(data);
      if (isGoogle && !text.trim()) {
        const issue = describeGeminiResponseIssue(data);
        if (issue) {
          _log("llm", "provider-error", issue, "error");
          if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
          return { ok: false, error: issue };
        }
      }

      _log("llm", "ok", `${elapsed}s | ${text.length}c | "${text.slice(0, 80).replace(/\n/g, " ")}…"`);
      return { ok: true, text, raw: data };

    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const detail = e.message === "Failed to fetch" && requestUrl ? `${e.message} (${requestUrl})` : e.message;
      _log("llm", "FAIL", `${elapsed}s | ${detail}`, "error");
      if (attempt < 3) {
        _log("llm", "retry", `attempt ${attempt + 1}/3 in 3s`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      return { ok: false, error: detail };
    }
  }
  return { ok: false, error: "All 3 attempts failed" };
}

// Helper: call LLM and get text, return null on failure (backward compat)
async function callLLM(messages, sys, agentConfig = {}) {
  const result = await llmCall(messages, sys, agentConfig);
  if (!result.ok) {
    _log("callLLM", "failed", result.error, "error");
    return null;
  }
  return result.text;
}

// Helper: call LLM expecting JSON, parse it
async function llmJSON(messages, sys, config = {}) {
  const text = await callLLM(messages, sys, config);
  if (!text) return null;
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) { _log("llmJSON", "no-json", text.slice(0, 100), "warn"); return null; }
    return JSON.parse(match[0]);
  } catch (e) {
    _log("llmJSON", "parse-fail", `${e.message} | ${text.slice(0, 100)}`, "warn");
    return null;
  }
}

async function llmJSONWithMeta(messages, sys, config = {}) {
  const result = await llmCall(messages, sys, config);
  if (!result.ok) return { ok: false, error: result.error, value: null };
  try {
    const cleaned = result.text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "Model returned no JSON", value: null };
    return { ok: true, error: null, value: JSON.parse(match[0]) };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}`, value: null };
  }
}

// ═══════════════════════════════════════════════════════════
// WEB SEARCH — with Anthropic tool + knowledge fallback
// ═══════════════════════════════════════════════════════════
async function webSearch(query, config = {}) {
  if (REQUIRE_PERSONAL_API_KEY && !hasPersonalApiKey(config)) {
    const error = getMissingKeyMessage(config);
    _log("search", "missing-key", error, "error");
    return { ok: false, text: "", sources: [], method: "missing-key", error };
  }

  const { model, apiKey, apiBase, isOpenAI, isAnthropic, isGoogle, hasCustomBase, provider } = resolveLLMConfig(config);
  const cacheKey = getWebSearchCacheKey({ provider, apiBase, model });
  const cachedToolState = _webSearchToolWorks.has(cacheKey) ? _webSearchToolWorks.get(cacheKey) : null;

  _log("search", "start", `"${query}"${cachedToolState === false ? " (tool disabled for this model/base, using fallback)" : ""}`);

  if (isOpenAI) {
    const searchModel = String(config.searchModel || (String(model).includes("search") ? model : DEFAULT_SEARCH_MODEL)).trim() || DEFAULT_SEARCH_MODEL;
    const searchUrl = joinApiPath(apiBase, "/v1/chat/completions");
    try {
      const res = await Promise.race([
        fetch(searchUrl, {
          method: "POST",
          headers: buildOpenAIHeaders(apiKey),
          body: JSON.stringify({
            model: searchModel,
            web_search_options: {},
            messages: [{ role: "user", content: query }],
          }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("search timeout")), 35000)),
      ]);

      if (res.ok) {
        const data = await res.json();
        const message = data.choices?.[0]?.message;
        const text = extractOpenAITextContent(message);
        const sources = extractOpenAISources(message, text);
        _log("search", "web-ok", `${sources.length} sources | ${text.length}c | ${searchModel}`);
        return { ok: true, text, sources, method: "openai-web", model: searchModel };
      }

      const err = await res.text().catch(() => "");
      _log("search", "web-fail", `HTTP ${res.status} | ${err.slice(0, 100)}`, "warn");
    } catch (e) {
      const detail = e.message === "Failed to fetch" ? `${e.message} (${searchUrl})` : e.message;
      _log("search", "web-error", detail, "warn");
    }
  }

  if (isGoogle && cachedToolState !== false) {
    const searchModel = String(config.searchModel || (GOOGLE_WEB_SEARCH_MODELS.has(model) ? model : DEFAULT_GOOGLE_SEARCH_MODEL)).trim() || DEFAULT_GOOGLE_SEARCH_MODEL;
    const searchUrl = joinApiPath(apiBase, `/v1beta/models/${encodeURIComponent(searchModel)}:generateContent`);
    try {
      const res = await Promise.race([
        fetch(searchUrl, {
          method: "POST",
          headers: buildGoogleHeaders(apiKey),
          body: JSON.stringify(buildGeminiRequestBody(
            [{ role: "user", content: query }],
            "Search the web and provide a comprehensive summary. Include specific facts and grounded citations.",
            2048,
            { tools: [{ google_search: {} }] }
          )),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("search timeout")), 35000)),
      ]);

      if (res.ok) {
        const data = await res.json();
        const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
        const text = extractGeminiTextContent(data);
        const sources = extractGeminiSources(candidate, text);
        if (text || sources.length) {
          _log("search", "web-ok", `${sources.length} sources | ${text.length}c | ${searchModel}`);
          _webSearchToolWorks.set(cacheKey, true);
          return { ok: true, text, sources, method: "google-web", model: searchModel };
        }
        const issue = describeGeminiResponseIssue(data);
        if (issue) _log("search", "web-empty", issue, "warn");
      } else {
        const err = await res.text().catch(() => "");
        _log("search", "web-fail", `HTTP ${res.status} | ${err.slice(0, 100)}`, "warn");
        if (shouldDisableWebSearch(res.status, err)) _webSearchToolWorks.set(cacheKey, false);
        else _webSearchToolWorks.delete(cacheKey);
      }
    } catch (e) {
      const detail = e.message === "Failed to fetch" ? `${e.message} (${searchUrl})` : e.message;
      _log("search", "web-error", detail, "warn");
      _webSearchToolWorks.delete(cacheKey);
    }
  }

  // Try Anthropic web_search tool — skip if it already failed
  if (isAnthropic && cachedToolState !== false) {
    const searchModel = ANTHROPIC_WEB_SEARCH_MODELS.has(model) ? model : DEFAULT_ANTHROPIC_SEARCH_MODEL;
    try {
      const url = hasCustomBase ? joinApiPath(apiBase, "/v1/messages") : "https://api.anthropic.com/v1/messages";
      const headers = buildAnthropicHeaders(apiKey);

      const res = await Promise.race([
        fetch(url, {
          method: "POST", headers,
          body: JSON.stringify({
            model: searchModel, max_tokens: 2048,
            system: "Search the web and provide a comprehensive summary. Include specific facts, data, and source URLs.",
            messages: [{ role: "user", content: `Search: ${query}` }],
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
          }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("search timeout")), 35000)),
      ]);

      if (res.ok) {
        const data = await res.json();
        const texts = [], sources = [];
        for (const block of (data.content || [])) {
          if (block.type === "text") texts.push(block.text);
          if (block.type === "web_search_tool_result") {
            for (const sr of (block.content || [])) {
              if (sr.type === "web_search_result") {
                sources.push({
                  title: sr.title || "", url: sr.url || "",
                  snippet: (sr.page_content || "").slice(0, 300),
                  fullContent: (sr.page_content || "").slice(0, 1500),
                });
              }
            }
          }
        }
        if (texts.length > 0 || sources.length > 0) {
          _log("search", "web-ok", `${sources.length} sources | ${texts.join("").length}c | ${searchModel}`);
          _webSearchToolWorks.set(cacheKey, true);
          return { ok: true, text: texts.join("\n"), sources, method: "web", model: searchModel };
        }
      } else {
        const err = await res.text().catch(() => "");
        _log("search", "web-fail", `HTTP ${res.status} | ${err.slice(0, 100)}`, "warn");
        if (shouldDisableWebSearch(res.status, err)) _webSearchToolWorks.set(cacheKey, false);
        else _webSearchToolWorks.delete(cacheKey);
      }
    } catch (e) {
      _log("search", "web-error", e.message, "warn");
      _webSearchToolWorks.delete(cacheKey);
    }
  }

  // Fallback: ask LLM from training knowledge
  _log("search", "fallback", `"${query}" — using LLM knowledge`);
  const result = await llmCall(
    [{ role: "user", content: `Research thoroughly: ${query}\n\nProvide key findings with specific facts, dates, numbers. Cite sources as [Name](URL) where known.` }],
    "You are a research assistant. Provide thorough, factual summaries with source citations.",
    config
  );
  if (!result.ok) { _log("search", "fallback-fail", result.error, "error"); return { ok: false, text: "", sources: [], method: "failed" }; }

  const urls = [...(result.text.matchAll(/https?:\/\/[^\s\])"',]+/g) || [])];
  const sources = urls.slice(0, 5).map(m => ({
    title: "", url: m[0], snippet: "", fullContent: "",
  }));
  _log("search", "fallback-ok", `${result.text.length}c | ${sources.length} URLs`);
  return { ok: true, text: result.text, sources, method: "knowledge" };
}

// ═══════════════════════════════════════════════════════════
// RESEARCH ENGINE — Deterministic state machine
// PLAN → [SEARCH → MERGE → REFLECT]×N → SYNTHESIZE
// Features: source dedup, running summary, gap analysis,
//           human steering, snake movement, visual feedback
// ═══════════════════════════════════════════════════════════
const MAX_RESEARCH_ITERATIONS = 2;

const PROMPTS = {
  PLAN: `Decompose a research question into 2-3 specific, non-overlapping search queries.
Reply ONLY with JSON: {"queries":["query1","query2"],"plan":"1 sentence research plan"}
Queries should be 3-6 words, specific, covering different angles. Keep it minimal — 2 queries for simple questions, 3 for complex ones.`,

  MERGE: `Merge new research findings into a running summary.
Reply ONLY with JSON: {"summary":"Updated summary (300-500 words). Extract key facts, statistics, quotes. Remove redundancy. Preserve source URLs. Attribute claims to sources."}
Read the actual content — don't just list titles.`,

  REFLECT: `Analyze research progress. Decide if the summary answers the question.
Reply ONLY with JSON: {"sufficient":true/false,"confidence":0.0-1.0,"gaps":["specific gap"],"queries":["targeted query for gap"]}
If sufficient (confidence>0.7), set gaps/queries to []. Never repeat previous queries.`,

  SYNTHESIZE: `Write a comprehensive research report.
Reply ONLY with JSON: {"title":"Clear title","content":"Markdown report (600-1200 words)","sources":["url1","url2"]}
Use ## headers, **bold**, - bullets. Start with ## Key Findings. Cite [Source](url) inline. End with ## Sources.`,
};

async function runResearch(question, snake, sRef, spawnPFn, rerenderFn) {
  const s = sRef.current;
  const head = () => snake.segments[0];
  const cfg = resolveLLMConfig({ model: snake.model, apiKey: snake.apiKey, apiBase: snake.apiBase });
  // Fast config: use Haiku for plan/reflect/merge (3x faster, 10x cheaper)
  // Falls back to same model if Haiku isn't available
  const fastModel = cfg.provider === "openai"
    ? "gpt-5.4-nano"
    : cfg.provider === "google"
    ? DEFAULT_GOOGLE_FAST_MODEL
    : "claude-haiku-4-5-20251001";
  const cfgFast = { ...cfg, model: fastModel, maxTokens: 1024 };
  const visitedUrls = new Set();
  const readBubbleIds = new Set();
  let summary = "";
  let allSources = [];
  let successfulModelCalls = 0;
  let successfulSearchCalls = 0;
  let lastFailure = "";
  const tick = () => { try { rerenderFn?.(n => n + 1); } catch {} };

  // ── Budget: hard limits guarantee termination ──
  const budget = { read: 0, maxRead: 18, startTime: Date.now(), maxTime: 180000 }; // 18 bubbles, 3 min
  const overBudget = () => budget.read >= budget.maxRead || (Date.now() - budget.startTime) > budget.maxTime;

  // ── Movement ──
  const moveTo = async (x, y, ms = 2000) => {
    snake.waypoint = { x, y }; tick();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (Math.abs(head().x - x) < 30 && Math.abs(head().y - y) < 30) break;
      await new Promise(r => setTimeout(r, 60));
    }
  };

  const readBub = (b) => {
    if (!b.readers.includes(snake.id)) { b.readers.push(snake.id); b.pulseAnim = 0.6; }
    readBubbleIds.add(b.id);
    budget.read++;
  };

  // ── Relevance scoring: cheap keyword overlap, no LLM call ──
  const scoreRelevance = (bubble, extraTerms = []) => {
    const words = [...question.toLowerCase().split(/\s+/), ...extraTerms]
      .flatMap(w => w.toLowerCase().split(/\s+/))
      .filter(t => t.length > 2);
    const unique = [...new Set(words)];
    if (!unique.length) return 0;
    const text = bubble.items.map(it => ((it.text || "") + " " + (it.summary || "")).toLowerCase()).join(" ");
    let hits = 0;
    for (const w of unique) if (text.includes(w)) hits++;
    return hits / unique.length;
  };

  const isEvidenceBubble = (bubble) => {
    if (bubble.isOnboarding) return false;
    if (bubble.fileType || bubble.isMemory || bubble.isResult || bubble.sourceUrl) return true;
    const categories = new Set((bubble.items || []).map(it => it.category));
    if (categories.has("question") || categories.has("plan")) return false;
    return true;
  };

  const failResearch = async (message) => {
    const detail = String(message || "Research failed").trim();
    const pos = placeBubble(detail, s.bubbles, head().x, head().y);
    s.bubbles.push(makeBubble(detail, "Research failed", "error", "assistant", pos.x, pos.y));
    s.notifications.push({
      id: uid(),
      text: `${snake.name}: ${truncate(detail, 40)}`,
      bubbleId: null,
      snakeColorIdx: snake.colorIdx,
      createdAt: Date.now(),
    });
    snake._researchPhase = null;
    snake._researchIteration = null;
    snake.waypoint = null;
    _log(snake.name, "research:error", detail, "error");
    tick();
    return null;
  };

  // ── Process human pins: interrupt, visit, read, add to findings ──
  const processPins = async (findings) => {
    while (snake._humanPins?.length && !overBudget()) {
      const pid = snake._humanPins.shift();
      const pb = s.bubbles.find(b => b.id === pid);
      if (!pb || readBubbleIds.has(pb.id)) continue;
      pb._pinned = false;
      _log(snake.name, "pin:visit", `"${bubbleSummary(pb)}"`);
      await moveTo(pb.x, pb.y, 500);
      readBub(pb);
      findings.push(`[PINNED by human: ${bubbleSummary(pb)}]\n${pb.items.map(it => it.text).join("\n").slice(0, 600)}`);
      spawnPFn(pb.x, pb.y, "#5ce0d8", 6);
      tick();
    }
  };

  // ── Spatial harvest: scan nearby unread bubbles, read if relevant ──
  const harvestNearby = async (findings, queryTerms = []) => {
    if (overBudget()) return;
    const h = head();
    const nearby = s.bubbles.filter(b =>
      !b.settled && !b.isResult && !readBubbleIds.has(b.id) &&
      !b.isMemory && b.items.length > 0 && isEvidenceBubble(b) &&
      dist(h, b) < PERCEPTION_RADIUS
    );
    if (!nearby.length) return;

    const scored = nearby
      .map(b => ({ b, score: scoreRelevance(b, queryTerms) }))
      .filter(x => x.score > 0.2) // only clearly relevant
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // max 3 per harvest

    for (const { b, score } of scored) {
      if (overBudget()) break;
      _log(snake.name, "harvest", `"${truncate(bubbleSummary(b), 25)}" score=${score.toFixed(2)} dist=${dist(h, b).toFixed(0)}`);
      await moveTo(b.x, b.y, 400);
      readBub(b);
      findings.push(`[Nearby: ${bubbleSummary(b)}]\n${b.items.map(it => it.text).join("\n").slice(0, 500)}`);
      spawnPFn(b.x, b.y, CATS.fact.color, 3);
      tick();
    }
  };

  _log(snake.name, "research:start", `"${question}" budget: ${budget.maxRead} bubbles / ${budget.maxTime/1000}s`);

  // ══════════════════════════════════════════
  // PHASE 1: PLAN
  // ══════════════════════════════════════════
  snake._researchPhase = "planning";
  tick();

  const planResult = await llmJSONWithMeta(
    [{ role: "user", content: `Research question: ${question}` }],
    PROMPTS.PLAN, cfgFast
  );
  if (planResult.ok) successfulModelCalls++;
  else lastFailure = planResult.error || lastFailure;
  const plan = planResult.value || { queries: [question], plan: "Direct search" };

  const queries = (plan.queries || [question]).slice(0, 5);
  _log(snake.name, "plan:ok", `${queries.length} queries: ${queries.join(" | ")}`);

  const planPos = placeBubble(plan.plan || question, s.bubbles, head().x + 80, head().y);
  const planBub = makeBubble(
    `Research plan: ${plan.plan || question}\n\nQueries:\n${queries.map((q,i) => `${i+1}. ${q}`).join("\n")}`,
    "Research plan", "plan", "assistant", planPos.x, planPos.y
  );
  s.bubbles.push(planBub);
  spawnPFn(planPos.x, planPos.y, CATS.plan.color, 8);
  tick();
  await moveTo(planPos.x, planPos.y, 700);
  readBub(planBub);

  // Harvest any existing relevant bubbles near starting position
  const initialFindings = [];
  await harvestNearby(initialFindings, queries);
  if (initialFindings.length) _log(snake.name, "harvest:initial", `${initialFindings.length} relevant nearby bubbles`);

  // ══════════════════════════════════════════
  // PHASE 2-4: SEARCH → MERGE → REFLECT loop
  // ══════════════════════════════════════════
  let gapQueries = queries;
  const sourcePositions = [];

  for (let iter = 0; iter < MAX_RESEARCH_ITERATIONS; iter++) {
    if (!gapQueries.length || overBudget()) {
      _log(snake.name, "iter:stop", overBudget() ? `budget exceeded (${budget.read}/${budget.maxRead} read, ${((Date.now()-budget.startTime)/1000).toFixed(0)}s)` : "no queries");
      break;
    }

    // ── SEARCH ──
    snake._researchPhase = `searching (${iter + 1}/${MAX_RESEARCH_ITERATIONS})`;
    tick();
    const findings = iter === 0 ? [...initialFindings] : [];
    const baseAngle = Math.random() * Math.PI * 2;

    for (let qi = 0; qi < Math.min(gapQueries.length, 3); qi++) {
      if (overBudget()) break;
      const q = gapQueries[qi];
      _log(snake.name, `search:${qi+1}`, `"${q}"`);

      // Check for human pins before each search
      await processPins(findings);

      // Snake fans out
      const angle = baseAngle + (qi / Math.min(gapQueries.length, 3)) * Math.PI * 1.5;
      await moveTo(head().x + Math.cos(angle) * 120, head().y + Math.sin(angle) * 90, 600);
      tick();

      // Harvest nearby relevant bubbles at this position
      await harvestNearby(findings, [q]);

      // Web search
      const result = await webSearch(q, cfg);
      if (!result.ok) { lastFailure = "Search request failed"; continue; }
      successfulSearchCalls++;

      const newSources = (result.sources || []).filter(src => src.url && !visitedUrls.has(src.url));
      for (const src of newSources.slice(0, 3)) {
        if (overBudget()) break;
        visitedUrls.add(src.url);
        const content = src.fullContent || src.snippet || "";
        const srcAngle = angle + (newSources.indexOf(src) - 1) * 0.4;
        const pos = placeBubble(content || src.title, s.bubbles,
          head().x + Math.cos(srcAngle) * 70, head().y + Math.sin(srcAngle) * 70);
        const srcBub = makeBubble(
          `${src.title}\n\n${content}\n\n${src.url}`,
          truncate(src.title || src.url, 28), "source", "user", pos.x, pos.y,
          buildSourceBubbleExtra(src)
        );
        s.bubbles.push(srcBub);
        allSources.push(src.url);
        sourcePositions.push({ x: pos.x, y: pos.y });
        if (content.length > 50) findings.push(`[${src.title}] (${src.url})\n${content.slice(0, 800)}`);

        spawnPFn(pos.x, pos.y, CATS.source.color, 4);
        tick();
        await moveTo(pos.x, pos.y, 400);
        readBub(srcBub);
        tick();
      }

      if (result.text) findings.push(`[Analysis]\n${result.text.slice(0, 1000)}`);
    }

    // Final pin check after all searches
    await processPins(findings);

    _log(snake.name, "search:done", `${findings.length} findings | budget ${budget.read}/${budget.maxRead} | ${((Date.now()-budget.startTime)/1000).toFixed(0)}s`);
    if (!findings.length) continue;

    // ── MERGE ──
    snake._researchPhase = `merging (${iter + 1}/${MAX_RESEARCH_ITERATIONS})`;
    if (sourcePositions.length) {
      const cx = sourcePositions.reduce((a, p) => a + p.x, 0) / sourcePositions.length;
      const cy = sourcePositions.reduce((a, p) => a + p.y, 0) / sourcePositions.length;
      await moveTo(cx, cy, 700);
    }
    tick();

    const mergeCtx = findings.join("\n\n---\n\n").slice(0, 8000);
    const mergeInput = summary
      ? `Question: ${question}\n\nCurrent summary:\n${summary}\n\nNew findings:\n${mergeCtx}`
      : `Question: ${question}\n\nFindings:\n${mergeCtx}`;
    _log(snake.name, "merge", `${mergeInput.length}c input`);

    const merged = await llmJSONWithMeta([{ role: "user", content: mergeInput }], PROMPTS.MERGE, cfgFast);
    if (merged.ok && merged.value?.summary) {
      successfulModelCalls++;
      summary = merged.value.summary;
    } else if (!summary && successfulModelCalls > 0) {
      summary = mergeCtx.slice(0, 600);
    } else {
      lastFailure = merged.error || lastFailure;
    }
    _log(snake.name, "merge:ok", `${summary.length}c summary`);

    // ── REFLECT ──
    if (iter < MAX_RESEARCH_ITERATIONS - 1 && !overBudget()) {
      snake._researchPhase = `reflecting (${iter + 1}/${MAX_RESEARCH_ITERATIONS})`;
      await moveTo(planBub.x, planBub.y, 700);
      tick();

      // Inject human steering
      let humanCtx = "";
      if (snake._steeringNotes?.length) {
        humanCtx += `\n\nHUMAN STEERING:\n${snake._steeringNotes.map(n => `- "${n}"`).join("\n")}`;
        snake._steeringNotes = [];
      }

      const reflectionResult = await llmJSONWithMeta(
        [{ role: "user", content: `Question: ${question}\n\nSummary:\n${summary}\n\nSources (${visitedUrls.size}): ${[...visitedUrls].slice(0, 10).join(", ")}${humanCtx}\n\nBudget remaining: ${budget.maxRead - budget.read} bubbles, ${Math.max(0, Math.round((budget.maxTime - (Date.now() - budget.startTime))/1000))}s` }],
        PROMPTS.REFLECT, cfgFast
      );
      if (reflectionResult.ok) successfulModelCalls++;
      else lastFailure = reflectionResult.error || lastFailure;
      const reflection = reflectionResult.value || { sufficient: successfulModelCalls === 0 && successfulSearchCalls === 0 };

      _log(snake.name, "reflect", `sufficient=${reflection.sufficient}, confidence=${reflection.confidence}, gaps=${(reflection.gaps||[]).length}`);

      if (reflection.sufficient || !(reflection.gaps?.length)) {
        _log(snake.name, "reflect:sufficient", "ending loop");
        break;
      }

      gapQueries = (reflection.queries || []).slice(0, 3);

      const gapText = `Knowledge gaps:\n${reflection.gaps.map(g => `- ${g}`).join("\n")}`;
      const gapPos = placeBubble(gapText, s.bubbles, head().x + 40, head().y - 40);
      const gapBub = makeBubble(gapText, `${reflection.gaps.length} gaps`, "analysis", "assistant", gapPos.x, gapPos.y);
      s.bubbles.push(gapBub);
      spawnPFn(gapPos.x, gapPos.y, CATS.analysis.color, 5);
      tick();
      await moveTo(gapPos.x, gapPos.y, 500);
      readBub(gapBub);
      tick();
    }
  }

  // ══════════════════════════════════════════
  // PHASE 5: SYNTHESIZE
  // ══════════════════════════════════════════
  snake._researchPhase = "writing report";
  const rx = sourcePositions.length ? sourcePositions.reduce((a,p)=>a+p.x,0)/sourcePositions.length : head().x;
  const ry = sourcePositions.length ? Math.min(...sourcePositions.map(p=>p.y)) - 100 : head().y - 100;
  await moveTo(rx, ry, 800);
  tick();

  let synthExtra = "";
  if (snake._steeringNotes?.length) { synthExtra = `\n\nHuman directives: ${snake._steeringNotes.join("; ")}`; snake._steeringNotes = []; }

  if (!summary && successfulModelCalls === 0 && successfulSearchCalls === 0) {
    return await failResearch(lastFailure || "Unable to reach the model or search service. Check the provider, API key, and local proxy.");
  }

  _log(snake.name, "synthesize", `${summary.length}c summary, ${allSources.length} sources → report`);
  const reportResult = await llmJSONWithMeta(
    [{ role: "user", content: `Question: ${question}\n\nResearch:\n${summary}\n\nSources: ${[...new Set(allSources)].join("\n")}${synthExtra}` }],
    PROMPTS.SYNTHESIZE, { ...cfg, maxTokens: 4096 }
  );
  if (!reportResult.ok || !reportResult.value?.content) {
    return await failResearch(reportResult.error || lastFailure || "Report generation failed");
  }
  successfulModelCalls++;
  const report = reportResult.value;

  _log(snake.name, "synthesize:ok", `"${report.title}" | ${(report.content||"").length}c`);

  // Create result
  const resultId = uid();
  s.results = s.results || [];
  s.results.push({ id: resultId, title: report.title || "Research Report", content: report.content || summary, sources: report.sources || allSources, snakeName: snake.name, createdAt: Date.now() });
  s.activeResultId = resultId;

  const pos = placeBubble(report.content || "", s.bubbles, head().x, head().y);
  const rb = makeBubble(report.content || summary, report.title || "Research Report", "result", "assistant", pos.x, pos.y, {
    isResult: true, resultTitle: report.title, resultSources: report.sources || allSources, resultId, autoSeekable: true,
  });
  rb.humanRead = false;
  s.bubbles.push(rb);
  spawnPFn(pos.x, pos.y, CATS.result.color, 24);
  tick();
  await moveTo(pos.x, pos.y, 600);
  readBub(rb);

  // Settle contributing bubbles
  for (const b of s.bubbles) {
    if (b.id !== rb.id && !b.isResult && !b.settled && readBubbleIds.has(b.id)) {
      b.settled = true; b.resultParentId = rb.id;
    }
  }

  const elapsed = ((Date.now() - budget.startTime) / 1000).toFixed(0);
  s.notifications.push({ id: uid(), text: `✨ ${truncate(report.title || "Report", 35)} (${elapsed}s, ${budget.read} sources)`, bubbleId: rb.id, snakeColorIdx: snake.colorIdx, createdAt: Date.now() });
  snake._researchPhase = null;
  snake._researchIteration = null;
  snake.waypoint = null;
  _log(snake.name, "research:done", `"${report.title}" | ${elapsed}s | ${budget.read} read | ${visitedUrls.size} web | ${allSources.length} cited`);
  tick();
  return rb;
}

// ═══════════════════════════════════════════════════════════
// LEGACY COMPAT — functions the UI auto-think loop still calls
// ═══════════════════════════════════════════════════════════
const RESEARCH_AGENT_SYS = `You are an autonomous research agent controlling a visual workspace.
Reply ONLY with valid JSON using this schema:
{"segments":[{"text":"what you want placed on the map","summary":"short label","category":"answer|analysis|plan|summary|source|action|error"}],"tool_calls":[{"tool":"web_search|spawn_agent|complete_task|produce_result","args":{}}]}

Tool rules:
- web_search args: {"query":"targeted search query"}
- spawn_agent args: {"task":"specific sub-task","name":"optional short name"}
- complete_task args: {"summary":"concise findings for the parent"}
- produce_result args: {"title":"report title","content":"markdown report","sources":["https://..."]}

Behavior rules:
- Use 1-3 tool calls max per turn.
- If you need evidence, call web_search instead of inventing sources.
- Only sub-agents should call complete_task.
- Only create segments when they add information worth showing to the user.
- Never include text outside the JSON object.`;

function trimContext(context, maxChars = 20000) {
  const msgs = context.map(c => ({ role: c.role === "system" ? "user" : c.role, content: String(c.content || "") }));
  let total = msgs.reduce((s, m) => s + m.content.length, 0);
  while (total > maxChars && msgs.length > 2) { total -= msgs[0].content.length; msgs.shift(); }
  if (msgs.length > 0 && msgs[0].role === "assistant") msgs.unshift({ role: "user", content: "[earlier context trimmed]" });
  return msgs;
}

async function getAIResponse(context, agentConfig = {}) {
  const raw = await callLLM(context, RESEARCH_AGENT_SYS, agentConfig);
  if (!raw) return { segments: [{ text: "No API response.", summary: "API error", category: "error" }], tool_calls: [] };
  if (raw.startsWith("[API")) return { segments: [{ text: raw, summary: "API error", category: "error" }], tool_calls: [] };
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        tool_calls: normalizeToolCalls(parsed.tool_calls),
      };
    }
  } catch {}
  return { segments: [{ text: raw.slice(0, 300), summary: "Response", category: "answer" }], tool_calls: [] };
}

async function digestFile(fileName, content, agentConfig = {}) {
  const text = await callLLM(
    [{ role: "user", content: `Analyze this file:\nFilename: ${fileName}\nContent (first 3000 chars):\n${content.slice(0, 3000)}` }],
    "You analyze files. Reply with JSON: {\"analysis\":\"concise analysis (200 chars max)\",\"summary\":\"2-4 word label\",\"category\":\"code|data|doc|config\"}",
    agentConfig
  );
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { analysis: parsed.analysis || text?.slice(0, 200) || fileName, summary: parsed.summary || fileName };
  } catch {
    return { analysis: text?.slice(0, 200) || `File: ${fileName}`, summary: fileName };
  }
}

async function compressContext(items, agentConfig = {}) {
  const blob = items.map(it => `[${it.role}] ${it.summary || ""}: ${it.content?.slice(0, 200)}`).join("\n");
  const text = await callLLM(
    [{ role: "user", content: `Compress these ${items.length} context items into a single memory:\n${blob}` }],
    "Compress context into a concise memory. Reply with JSON: {\"text\":\"compressed memory (300 chars max)\",\"summary\":\"2-4 word label\"}",
    agentConfig
  );
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { text: parsed.text || text?.slice(0, 300) || "Memory", summary: parsed.summary || "Memory" };
  } catch {
    return { text: text?.slice(0, 300) || "Compressed memory", summary: "Memory" };
  }
}

function normalizeToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map(call => {
    if (!call || typeof call !== "object") return null;
    const tool = String(call.tool || call.name || "").trim();
    let args = call.args ?? call.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); }
      catch { args = tool === "web_search" ? { query: args } : { value: args }; }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    return tool ? { tool, args } : null;
  }).filter(Boolean);
}

function createResultArtifacts(s, snake, payload = {}, spawnPFn) {
  const title = String(payload.title || payload.summary || snake.task || "Agent Report").trim() || "Agent Report";
  const content = String(payload.content || payload.summary || "").trim() || "Research completed.";
  const sources = Array.isArray(payload.sources) ? payload.sources.filter(Boolean) : [];
  const resultId = uid();
  s.results = s.results || [];
  s.results.push({
    id: resultId,
    title,
    content,
    sources,
    snakeName: snake.name,
    createdAt: Date.now(),
  });
  s.activeResultId = resultId;

  const head = snake.segments[0];
  const pos = placeBubble(content, s.bubbles, head.x, head.y - 40);
  const rb = makeBubble(content, title, "result", "assistant", pos.x, pos.y, {
    isResult: true,
    resultTitle: title,
    resultSources: sources,
    resultId,
    autoSeekable: true,
  });
  rb.humanRead = false;
  s.bubbles.push(rb);
  spawnPFn(pos.x, pos.y, CATS.result.color, 16);

  snake.lastActivityTime = Date.now();
  snake.task = null;
  snake.autoSeek = false;
  snake.waypoint = { x: pos.x, y: pos.y };
  s.notifications.push({
    id: uid(),
    text: `${snake.name}: produced ${truncate(title, 28)}`,
    bubbleId: rb.id,
    snakeColorIdx: snake.colorIdx,
    createdAt: Date.now(),
  });
  return rb;
}

function spawnSubAgentFromTool(s, snake, args, spawnPFn) {
  const task = String(args.task || args.query || args.prompt || "").trim();
  if (!task) return null;
  if (s.snakes.filter(sn => sn.alive).length >= MAX_ALIVE_SNAKES) return null;
  if ((snake.depth || 0) >= MAX_SPAWN_DEPTH) return null;

  const ci = s.nextColor++;
  const name = String(args.name || "").trim() || `Agent ${PALETTES[ci % PALETTES.length].name}`;
  const seedContext = [
    ...snake.context,
    {
      role: "user",
      content: `Assigned by ${snake.name}: ${task}`,
      summary: `Task: ${truncate(task, 28)}`,
      category: "plan",
    },
  ];
  const ns = makeSnake(snake.segments[0].x + 30, snake.segments[0].y + 30, ci, seedContext, task, {
    model: snake.model,
    apiKey: snake.apiKey,
    apiBase: snake.apiBase,
    parentId: snake.id,
    depth: (snake.depth || 0) + 1,
    name,
  });
  ns.spawnAnim = 1.0;
  ns.pendingThink = Date.now();
  ns.lastActivityTime = Date.now();

  if (!snake.childIds.includes(ns.id)) snake.childIds.push(ns.id);
  snake.lastActivityTime = Date.now();
  snake.context.push({
    role: "assistant",
    content: `Spawned ${ns.name} to research: ${task}`,
    summary: `Spawned ${ns.name}`,
    category: "action",
  });
  s.snakes.push(ns);
  spawnPFn(snake.segments[0].x, snake.segments[0].y, PALETTES[ci % PALETTES.length].body, 14);
  s.notifications.push({
    id: uid(),
    text: `${snake.name}: spawned ${ns.name}`,
    bubbleId: null,
    snakeColorIdx: snake.colorIdx,
    createdAt: Date.now(),
  });
  return ns;
}

function completeSubAgentTask(s, snake, args, spawnPFn) {
  if (!snake.parentId) return null;
  const parent = s.snakes.find(sn => sn.id === snake.parentId && sn.alive);
  if (!parent) return null;

  const summary = String(args.summary || args.content || args.value || "").trim() || `Completed task: ${snake.task || "sub-task"}`;
  snake.context.push({
    role: "assistant",
    content: summary,
    summary: `Complete: ${truncate(snake.task || "task", 18)}`,
    category: "summary",
  });
  snake.lastActivityTime = Date.now();
  parent.lastActivityTime = Date.now();

  const pos = placeBubble(summary, s.bubbles, snake.segments[0].x, snake.segments[0].y);
  const bubble = makeBubble(summary, `${snake.name}: complete`, "summary", "assistant", pos.x, pos.y);
  s.bubbles.push(bubble);
  spawnPFn(pos.x, pos.y, CATS.summary.color, 10);

  snake.pendingMerge = { targetSnakeId: parent.id, role: "absorbed" };
  parent.pendingMerge = { targetSnakeId: snake.id, role: "survivor" };
  snake.pendingThink = 0;
  snake.waypoint = null;
  snake.leash = null;
  snake.scentTrail = null;

  s.notifications.push({
    id: uid(),
    text: `${snake.name}: completed task, merging back`,
    bubbleId: bubble.id,
    snakeColorIdx: snake.colorIdx,
    createdAt: Date.now(),
  });
  return bubble;
}

async function executeToolCalls(toolCalls, snake, sRef, tickRef, spawnPFn, rerenderFn) {
  const s = sRef.current;
  for (const call of normalizeToolCalls(toolCalls)) {
    const toolName = call.tool;
    const args = call.args || {};
    _log(snake.name, "tool", `${toolName}: ${JSON.stringify(args).slice(0, 80)}`);

    if (toolName === "web_search" && args.query) {
      const result = await webSearch(args.query, { model: snake.model, apiKey: snake.apiKey, apiBase: snake.apiBase });
      if (!result.ok) continue;
      const hd = snake.segments[0];
      for (const src of (result.sources || []).slice(0, 3)) {
        const pos = placeBubble(src.snippet || src.title, s.bubbles, hd.x + (Math.random() - 0.5) * 150, hd.y + (Math.random() - 0.5) * 150);
        s.bubbles.push(makeBubble(`${src.title}\n\n${src.snippet}\n\n${src.url}`, truncate(src.title || src.url, 28), "source", "user", pos.x, pos.y,
          buildSourceBubbleExtra(src)
        ));
      }
      snake.context.push({ role: "user", content: `[Search: "${args.query}"]\n${(result.text || "").slice(0, 600)}`, summary: `Search: ${args.query}`, category: "source" });
      snake.lastActivityTime = Date.now();
      if (!snake.isThinking && !snake.pendingThink) snake.pendingThink = Date.now();
      rerenderFn?.(n => n + 1);
      continue;
    }

    if (toolName === "spawn_agent") {
      spawnSubAgentFromTool(s, snake, args, spawnPFn);
      rerenderFn?.(n => n + 1);
      continue;
    }

    if (toolName === "complete_task") {
      completeSubAgentTask(s, snake, args, spawnPFn);
      rerenderFn?.(n => n + 1);
      continue;
    }

    if (toolName === "produce_result") {
      createResultArtifacts(s, snake, args, spawnPFn);
      rerenderFn?.(n => n + 1);
      continue;
    }

    _log(snake.name, "tool:ignored", toolName, "warn");
  }
}

// Backward-compat alias
async function callLLMWithSearch(query, agentConfig = {}) {
  const result = await webSearch(query, agentConfig);
  if (!result.ok) return null;
  return { text: result.text, sources: result.sources };
}
function placeBubble(text, existing, ax, ay) {
  const words = new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  let x = ax + (Math.random() - 0.3) * 280, y = ay + (Math.random() - 0.5) * 220;
  for (const b of existing.slice(-20)) {
    const full = (b.items || []).map(i => i.text).join(" ");
    const bw = new Set(full.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let ov = 0; for (const w of words) if (bw.has(w)) ov++;
    if (ov > 0) { x += (b.x - x) * 0.12 * ov; y += (b.y - y) * 0.12 * ov; }
  }
  for (let i = 0; i < 10; i++)
    for (const b of existing) {
      const d = dist({ x, y }, b);
      if (d < 85 && d > 0) { const a = Math.atan2(y - b.y, x - b.x); x += Math.cos(a) * 20; y += Math.sin(a) * 20; }
    }
  return { x: clamp(x, 80, MAP_W - 80), y: clamp(y, 80, MAP_H - 80) };
}

function makeBubble(text, summary, category, role, x, y, extra = {}) {
  return {
    id: uid(), x, y,
    items: [{ text, summary, category, role }],
    readers: [], pulseAnim: 1.0,
    autoSeekable: extra.autoSeekable !== undefined ? extra.autoSeekable : (role !== "file"),
    createdAt: Date.now(),
    humanRead: role === "user",
    settled: false, resultParentId: null, litUntil: 0,
    ...extra,
  };
}

function makeByokOnboardingBubble(x = MAP_W / 2, y = MAP_H / 2) {
  const text = normalizeMarkdownText(`
## Bring Your Own API Key

This public version of Context Snake runs on **your own OpenAI, Anthropic, or Google Gemini API key**, so usage stays on your account.

### Set It Up
1. Click a snake head to select it.
2. Open **Agent Config** for that snake.
3. Choose **OpenAI**, **Anthropic**, or **Google Gemini**.
4. Paste your personal API key.

### Get A Key
- [OpenAI API keys](https://platform.openai.com/api-keys)
- [OpenAI quickstart](https://platform.openai.com/docs/quickstart)
- [Anthropic Console](https://console.anthropic.com/)
- [Anthropic API overview](https://docs.anthropic.com/en/api/overview)
- [Google AI Studio API keys](https://aistudio.google.com/app/apikey)
- [Gemini API key guide](https://ai.google.dev/gemini-api/docs/api-key)

This setup card disappears as soon as you save a key.
  `).trim();

  return makeBubble(text, "BYOK setup", "plan", "system", x, y, {
    isOnboarding: true,
    autoSeekable: false,
    settled: true,
    humanRead: false,
  });
}

function syncByokOnboarding(state) {
  const hadBubble = (state.bubbles || []).some(b => b.isOnboarding);
  const hasKey = (state.snakes || []).some(sn => sn.alive && hasPersonalApiKey(sn));
  const hasRealBubbles = (state.bubbles || []).some(b => !b.isOnboarding);

  if (hasKey) {
    if (!hadBubble) return false;
    state.bubbles = state.bubbles.filter(b => !b.isOnboarding);
    return true;
  }

  if (hadBubble || hasRealBubbles) return false;
  state.bubbles.push(makeByokOnboardingBubble(MAP_W / 2, MAP_H / 2 - 70));
  return true;
}

function bubbleSummary(b) { return b.items.length === 1 ? b.items[0].summary : `${b.items.length} items · ${b.items[0].summary}`; }
function bubbleCat(b) {
  if (b.fileType) return "file";
  if (b.isMemory) return "memory";
  if (b.items.length === 1) return b.items[0].category;
  const c = {}; for (const i of b.items) c[i.category] = (c[i.category] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
function bubbleLen(b) { return b.items.reduce((s, i) => s + i.text.length, 0); }

function estimateBubbleTextWidth(text, fontSize = 10) {
  return String(text || "").length * fontSize * 0.58;
}

function getBubblePillSize(b) {
  const label = truncate(bubbleSummary(b), 20);
  const isResult = !!b.isResult;
  const isSource = !!b.sourceUrl;
  const isSettled = b.settled && !isResult;
  const labelW = estimateBubbleTextWidth(label, isResult ? 13 : 10);
  const basePillH = isResult ? 52 : isSettled ? 22 : isSource ? 52 : 30;
  const basePillW = isResult
    ? Math.max(180, labelW + 70)
    : isSettled
    ? Math.max(44, labelW + 24)
    : isSource
    ? Math.max(140, labelW + 44)
    : Math.max(60, labelW + 40);
  const pulse = b.pulseAnim > 0 ? 1 + b.pulseAnim * 0.15 : 1;
  return { width: basePillW * pulse, height: basePillH * pulse };
}

function bubbleContainsPoint(b, point, padding = 8) {
  const { width, height } = getBubblePillSize(b);
  return Math.abs(point.x - b.x) <= width / 2 + padding && Math.abs(point.y - b.y) <= height / 2 + padding;
}

function findResultBubbleById(bubbles, resultId) {
  if (!resultId) return null;
  return bubbles.find(b => b.isResult && b.resultId === resultId) || null;
}

function pickBubbleAtPoint(state, point, opts = {}) {
  const bubbles = state.bubbles || [];
  const topDown = [...bubbles].reverse();
  const activeResultBubble = opts.preferActiveResult ? findResultBubbleById(bubbles, state.activeResultId) : null;

  if (activeResultBubble) {
    if (bubbleContainsPoint(activeResultBubble, point, 30)) return activeResultBubble;
    for (const b of topDown) {
      if (b.resultParentId === activeResultBubble.id && bubbleContainsPoint(b, point, 10)) return activeResultBubble;
    }
  }

  for (const b of topDown) {
    if (!bubbleContainsPoint(b, point)) continue;
    if (b.resultParentId) {
      const parent = bubbles.find(p => p.id === b.resultParentId && p.isResult);
      if (parent && bubbleContainsPoint(parent, point, 30)) return parent;
    }
    return b;
  }

  if (!opts.preferResults) return null;

  for (const b of topDown) {
    if (b.isResult && bubbleContainsPoint(b, point, 30)) return b;
  }

  return null;
}

function getPrimarySnake(state) {
  return state.snakes.find(sn => sn.id === state.selectedSnake && sn.alive) || state.snakes.find(sn => sn.alive) || null;
}

function getSelectedSnake(state) {
  return state.snakes.find(sn => sn.id === state.selectedSnake && sn.alive) || null;
}

function getMissingKeyMessage(config = {}) {
  const provider = detectProvider(config?.model, config?.apiBase);
  const label = getProviderPreset(provider).label;
  return `Missing ${label} API key. Add your personal key in Agent Config to continue.`;
}

function getSnakeBusyReason(state, snake) {
  if (!snake || !snake.alive) return "unavailable";
  if (snake.pendingMerge) return "merging";
  if (snake._researchPhase) return "researching";
  if (snake.isThinking) return "thinking";
  if (snake._digestingFile || state.pendingDigests?.some(d => d.snakeId === snake.id)) return "digesting";
  return "";
}

function normalizeMarkdownText(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\]\s*\n\s*\(/g, "](")
    .replace(/^\s*•\s+/gm, "- ");
}

function getBubblePreviewText(b, maxChars = 640) {
  if (!b) return "";
  let text = "";
  if (b.isResult) text = b.items.map(it => it.text).join("\n\n");
  else if (b.sourceUrl) text = [getSourcePreviewBody(b, maxChars), b.sourceUrl ? `[Open source](${b.sourceUrl})` : ""].filter(Boolean).join("\n\n");
  else text = b.items.map(it => it.text).join("\n\n");

  const normalized = normalizeMarkdownText(text).trim();
  if (!normalized) return bubbleSummary(b);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).replace(/\s+\S*$/, "").trim()}…`;
}

function markdownToPlainText(text = "") {
  return normalizeMarkdownText(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveSessionName(state) {
  const latestResult = [...(state.results || [])].reverse().find(r => r?.title?.trim());
  if (latestResult?.title) return normalizeSessionName(markdownToPlainText(latestResult.title));

  const firstUserBubble = (state.bubbles || []).find(b => !b.isOnboarding && b.items?.[0]?.role === "user" && !b.fileType);
  if (firstUserBubble) {
    const userLabel = markdownToPlainText(firstUserBubble.items?.[0]?.summary || firstUserBubble.items?.[0]?.text || "");
    if (userLabel) return normalizeSessionName(truncate(userLabel, 52));
  }

  const firstResultBubble = (state.bubbles || []).find(b => !b.isOnboarding && b.isResult && (b.resultTitle || b.items?.[0]?.text));
  if (firstResultBubble) {
    const resultLabel = markdownToPlainText(firstResultBubble.resultTitle || firstResultBubble.items?.[0]?.text || "");
    if (resultLabel) return normalizeSessionName(truncate(resultLabel, 52));
  }

  const firstMeaningfulBubble = (state.bubbles || []).find(b => !b.isOnboarding && !b.fileType && !b.isMemory && !b.sourceUrl);
  if (firstMeaningfulBubble) {
    const label = markdownToPlainText(bubbleSummary(firstMeaningfulBubble) || firstMeaningfulBubble.items?.[0]?.text || "");
    if (label) return normalizeSessionName(truncate(label, 52));
  }

  return normalizeSessionName(`Session ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`);
}

function makeUniqueSessionName(baseName, currentName = "") {
  const base = normalizeSessionName(baseName) || createDraftSessionName();
  const taken = new Set(Storage.listMaps().filter(name => name !== currentName));
  if (!taken.has(base)) return base;
  let idx = 2;
  let candidate = `${base} (${idx})`;
  while (taken.has(candidate)) {
    idx += 1;
    candidate = `${base} (${idx})`;
  }
  return candidate;
}

function extractMarkdownLead(text, maxChars = 240) {
  const lines = normalizeMarkdownText(text).split("\n");
  let inCode = false;
  let paragraph = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,3}\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^---+$/.test(trimmed)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }

  const plain = markdownToPlainText(paragraph.join(" "));
  if (!plain) return "";
  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars).replace(/\s+\S*$/, "").trim()}…`;
}

function extractMarkdownOutline(text, maxItems = 6) {
  const lines = normalizeMarkdownText(text).split("\n");
  const sections = [];
  let inCode = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !trimmed) continue;
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = markdownToPlainText(headingMatch[2]);
      if (title && !sections.some(section => section.title === title)) {
        sections.push({ level, title });
        if (sections.length >= maxItems) return sections;
      }
    }
  }

  if (sections.length) return sections;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const title = markdownToPlainText(trimmed.replace(/^([-*]|\d+\.)\s+/, ""));
      if (title && !sections.some(section => section.title === title)) {
        sections.push({ level: 2, title });
        if (sections.length >= Math.min(4, maxItems)) break;
      }
    }
  }

  return sections;
}

function looksLikeSameText(a = "", b = "") {
  const left = markdownToPlainText(a).toLowerCase();
  const right = markdownToPlainText(b).toLowerCase();
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function stripSourceBoilerplate(text = "", title = "", url = "") {
  const titleLine = normalizeMarkdownText(title).trim();
  const urlLine = String(url || "").trim();
  const lines = normalizeMarkdownText(text)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line !== titleLine && line !== urlLine);
  return lines.join("\n\n").trim();
}

function getSourcePreviewBody(b, maxChars = 420) {
  if (!b) return "";
  const rawText = stripSourceBoilerplate(b.items.map(it => it.text).join("\n\n"), b.sourceTitle, b.sourceUrl);
  const sourceText = normalizeMarkdownText(b.sourceSnippet || rawText).trim();
  if (!sourceText) return "";
  if (sourceText.length <= maxChars) return sourceText;
  return `${sourceText.slice(0, maxChars).replace(/\s+\S*$/, "").trim()}…`;
}

function extractInsightBullets(text = "", maxItems = 3, maxChars = 150) {
  const plain = markdownToPlainText(text);
  if (!plain) return [];
  const sentences = plain.match(/[^.!?]+[.!?]?/g) || [];
  const picks = [];
  for (const sentence of sentences) {
    const normalized = sentence.replace(/\s+/g, " ").trim();
    if (normalized.length < 42) continue;
    if (picks.some(existing => looksLikeSameText(existing, normalized))) continue;
    picks.push(normalized.length > maxChars ? `${normalized.slice(0, maxChars).replace(/\s+\S*$/, "").trim()}…` : normalized);
    if (picks.length >= maxItems) break;
  }
  return picks;
}

function extractYouTubeVideoId(url = "") {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") return parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
    if (host.endsWith("youtube.com")) {
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v") || "";
      if (parsed.pathname.startsWith("/shorts/") || parsed.pathname.startsWith("/embed/")) {
        return parsed.pathname.split("/").filter(Boolean)[1] || "";
      }
    }
  } catch {}
  return "";
}

function humanizeHostname(hostname = "") {
  return String(hostname || "")
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean)
    .slice(0, -1)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || String(hostname || "").replace(/^www\./, "");
}

function buildSourceDisplayData(sourceUrl, raw = {}) {
  const cleanUrl = String(sourceUrl || raw.canonicalUrl || "").trim();
  let hostname = "";
  let pathLabel = "";
  try {
    const parsed = new URL(cleanUrl);
    hostname = parsed.hostname.replace(/^www\./, "");
    pathLabel = decodeURIComponent(parsed.pathname || "/").replace(/\/$/, "") || "/";
  } catch {}

  const lowerHost = hostname.toLowerCase();
  const lowerUrl = cleanUrl.toLowerCase();
  const lowerPath = pathLabel.toLowerCase();
  const youtubeId = extractYouTubeVideoId(cleanUrl);
  const contentType = String(raw.contentType || "").toLowerCase();
  const isDirectImage = /\.(png|jpe?g|webp|gif|svg)([?#].*)?$/i.test(lowerUrl) || contentType.startsWith("image/");
  const isPdf = /\.pdf([?#].*)?$/i.test(lowerUrl) || contentType.includes("pdf");
  const isVideo = /\.(mp4|mov|webm)([?#].*)?$/i.test(lowerUrl) || contentType.startsWith("video/");
  const isAudio = /\.(mp3|wav|m4a|aac|ogg)([?#].*)?$/i.test(lowerUrl) || contentType.startsWith("audio/");

  let kind = "website";
  let kindLabel = "Website";
  let icon = "🔗";

  if (youtubeId || lowerHost.includes("youtube.com") || lowerHost === "youtu.be") {
    kind = "video";
    kindLabel = "YouTube video";
    icon = "▶";
  } else if (isDirectImage) {
    kind = "image";
    kindLabel = "Image";
    icon = "🖼";
  } else if (isPdf) {
    kind = "document";
    kindLabel = "PDF";
    icon = "📄";
  } else if (isVideo) {
    kind = "video";
    kindLabel = "Video";
    icon = "▶";
  } else if (isAudio) {
    kind = "audio";
    kindLabel = "Audio";
    icon = "♪";
  } else if (lowerHost.includes("wikipedia.org") || lowerHost.includes("britannica.com") || lowerHost.includes("history.com")) {
    kind = "reference";
    kindLabel = "Reference";
    icon = "📚";
  } else if (lowerHost.includes("arxiv.org")) {
    kind = "paper";
    kindLabel = "Paper";
    icon = "📑";
  } else if (lowerHost.includes("github.com")) {
    kind = "code";
    kindLabel = "Code";
    icon = "⌘";
  }

  const previewImage = String(raw.image || raw.previewImage || "").trim()
    || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "")
    || (isDirectImage ? cleanUrl : "");

  return {
    url: cleanUrl,
    canonicalUrl: String(raw.canonicalUrl || cleanUrl).trim() || cleanUrl,
    hostname,
    hostLabel: hostname || cleanUrl,
    siteName: String(raw.siteName || (youtubeId ? "YouTube" : humanizeHostname(hostname))).trim() || hostname || "Website",
    pathLabel,
    kind,
    kindLabel,
    icon,
    title: markdownToPlainText(raw.title || ""),
    description: markdownToPlainText(raw.description || ""),
    previewImage,
    faviconUrl: hostname ? `https://icons.duckduckgo.com/ip3/${hostname}.ico` : "",
    videoId: youtubeId,
    contentType: String(raw.contentType || ""),
    sourceBadge: lowerPath === "/" || !pathLabel ? hostname : `${hostname}${pathLabel}`,
  };
}

function getSourceDisplayData(b) {
  if (!b?.sourceUrl) return null;
  const sourceBody = getSourcePreviewBody(b, 520);
  const sourceMeta = b.sourceMeta || {};
  const display = buildSourceDisplayData(b.sourceUrl, {
    title: sourceMeta.title || b.sourceTitle || bubbleSummary(b),
    description: sourceMeta.description || b.sourceSnippet || sourceBody,
    siteName: sourceMeta.siteName,
    image: sourceMeta.image || sourceMeta.previewImage,
    canonicalUrl: sourceMeta.canonicalUrl,
    contentType: sourceMeta.contentType,
  });
  const title = markdownToPlainText(display.title || b.sourceTitle || bubbleSummary(b) || display.siteName || display.hostLabel);
  let description = markdownToPlainText(display.description || sourceBody);
  if (looksLikeSameText(description, title)) description = "";
  const lead = extractMarkdownLead(description || sourceBody, 220);
  const highlights = extractInsightBullets(description || sourceBody, 3, 146);
  return {
    ...display,
    title: title || display.siteName || display.hostLabel || "External source",
    description,
    lead,
    highlights,
  };
}

function buildSourceBubbleExtra(src = {}) {
  const display = buildSourceDisplayData(src.url, {
    title: src.title,
    description: src.snippet || src.fullContent || "",
  });
  return {
    sourceUrl: src.url,
    sourceTitle: src.title,
    sourceSnippet: src.snippet || "",
    sourceDomain: display.hostname || src.url,
    sourceMeta: {
      title: display.title || src.title || "",
      description: display.description || src.snippet || "",
      siteName: display.siteName,
      previewImage: display.previewImage,
      contentType: display.contentType,
      canonicalUrl: display.canonicalUrl,
    },
  };
}

function getPreviewProxyRoot(apiBase = DEFAULT_API_BASE) {
  const base = normalizeApiBase(apiBase);
  if (/\/(openai|anthropic|google)$/.test(base)) return base.replace(/\/(openai|anthropic|google)$/, "");
  return "";
}

async function fetchSourcePreviewMetadata(sourceUrl, apiBase = DEFAULT_API_BASE) {
  const cleanUrl = String(sourceUrl || "").trim();
  if (!cleanUrl) return null;
  if (_sourcePreviewCache.has(cleanUrl)) return _sourcePreviewCache.get(cleanUrl);

  const proxyRoot = getPreviewProxyRoot(apiBase);
  if (!proxyRoot) {
    const empty = Promise.resolve(null);
    _sourcePreviewCache.set(cleanUrl, empty);
    return empty;
  }

  const previewUrl = `${proxyRoot}/preview?url=${encodeURIComponent(cleanUrl)}`;
  const request = Promise.race([
    fetch(previewUrl).then(async res => {
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") return null;
      return {
        title: markdownToPlainText(data.title || ""),
        description: markdownToPlainText(data.description || ""),
        siteName: markdownToPlainText(data.siteName || ""),
        image: String(data.image || "").trim(),
        canonicalUrl: String(data.canonicalUrl || data.url || cleanUrl).trim(),
        contentType: String(data.contentType || "").trim(),
      };
    }).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), 7000)),
  ]);

  _sourcePreviewCache.set(cleanUrl, request);
  return request;
}

function renderMarkdownInline(text, keyPrefix = "md") {
  if (!text) return text;
  const parts = [];
  const tokenRe = /(\[([^\]]+)\]\((https?:\/\/[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|(https?:\/\/[^\s<]+))/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2] && match[3]) {
      parts.push(
        <a
          key={`${keyPrefix}-link-${key++}`}
          onClick={() => window.open(match[3], "_blank")}
          style={{ color: "#7dc9ff", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}
          title={match[3]}
        >
          {match[2]}
        </a>
      );
    } else if (match[4] || match[5]) {
      parts.push(
        <strong key={`${keyPrefix}-strong-${key++}`} style={{ color: "#f3f6ff", fontWeight: 700 }}>
          {match[4] || match[5]}
        </strong>
      );
    } else if (match[6]) {
      parts.push(
        <code
          key={`${keyPrefix}-code-${key++}`}
          style={{ background: "#111425", padding: "1px 6px", borderRadius: 5, fontSize: "0.92em", color: "#9ce8d5" }}
        >
          {match[6]}
        </code>
      );
    } else if (match[7]) {
      parts.push(
        <a
          key={`${keyPrefix}-url-${key++}`}
          onClick={() => window.open(match[7], "_blank")}
          style={{ color: "#7dc9ff", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}
          title={match[7]}
        >
          {match[7]}
        </a>
      );
    }
    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderMarkdownBlocks(text, opts = {}) {
  const compact = !!opts.compact;
  const normalized = normalizeMarkdownText(text);
  const lines = normalized.split("\n");
  const nodes = [];
  let inCode = false;
  let codeLines = [];
  let key = 0;

  const blockStyles = {
    h1: { color: CATS.result.color, fontSize: compact ? 18 : 24, fontWeight: 800, margin: compact ? "14px 0 8px" : "22px 0 12px", lineHeight: 1.2 },
    h2: { color: "#f2f5ff", fontSize: compact ? 15 : 20, fontWeight: 780, margin: compact ? "16px 0 8px" : "24px 0 10px", lineHeight: 1.25, letterSpacing: "-0.01em" },
    h3: { color: "#dce7ff", fontSize: compact ? 13 : 16, fontWeight: 720, margin: compact ? "12px 0 6px" : "18px 0 8px", lineHeight: 1.3 },
    p: { margin: compact ? "6px 0" : "10px 0", fontSize: compact ? 12.5 : 14.5, color: compact ? "#c0c6d8" : "#c8cfdf", lineHeight: compact ? 1.72 : 1.82 },
    li: { margin: compact ? "4px 0" : "8px 0", fontSize: compact ? 12.5 : 14.5, color: compact ? "#c0c6d8" : "#c8cfdf", lineHeight: compact ? 1.72 : 1.82 },
    quote: { borderLeft: "3px solid #2f3f66", paddingLeft: compact ? 12 : 14, color: "#97a4c2", fontStyle: "italic", margin: compact ? "8px 0" : "12px 0", fontSize: compact ? 12 : 14 },
  };

  const flushCode = () => {
    if (!codeLines.length) return;
    nodes.push(
      <pre
        key={`md-code-${key++}`}
        style={{
          margin: compact ? "10px 0" : "14px 0",
          padding: compact ? "10px 12px" : "12px 14px",
          background: "#0d1020",
          border: "1px solid #1c2340",
          borderRadius: 10,
          color: "#cfe4ff",
          fontSize: compact ? 11 : 12,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {codeLines.join("\n")}
      </pre>
    );
    codeLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (trimmed === "") {
      nodes.push(<div key={`md-space-${key++}`} style={{ height: compact ? 6 : 10 }} />);
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      nodes.push(<div key={`md-rule-${key++}`} style={{ borderTop: "1px solid #1b2140", margin: compact ? "10px 0" : "16px 0" }} />);
      continue;
    }
    if (trimmed.startsWith("### ")) {
      nodes.push(<div key={`md-h3-${key++}`} style={blockStyles.h3}>{renderMarkdownInline(trimmed.slice(4), `h3-${key}`)}</div>);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      nodes.push(<div key={`md-h2-${key++}`} style={blockStyles.h2}>{renderMarkdownInline(trimmed.slice(3), `h2-${key}`)}</div>);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      nodes.push(<div key={`md-h1-${key++}`} style={blockStyles.h1}>{renderMarkdownInline(trimmed.slice(2), `h1-${key}`)}</div>);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const num = trimmed.match(/^\d+/)?.[0] || "";
      nodes.push(
        <div key={`md-ol-${key++}`} style={{ ...blockStyles.li, paddingLeft: compact ? 22 : 26, position: "relative" }}>
          <span style={{ position: "absolute", left: 2, color: "#6f7ea5", fontWeight: 700 }}>{num}.</span>
          {renderMarkdownInline(trimmed.replace(/^\d+\.\s+/, ""), `ol-${key}`)}
        </div>
      );
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^•\s+/.test(trimmed)) {
      const content = trimmed.replace(/^[-*•]\s+/, "");
      nodes.push(
        <div key={`md-ul-${key++}`} style={{ ...blockStyles.li, paddingLeft: compact ? 20 : 24, position: "relative" }}>
          <span style={{ position: "absolute", left: 4, color: "#5e6a8d" }}>•</span>
          {renderMarkdownInline(content, `ul-${key}`)}
        </div>
      );
      continue;
    }
    if (trimmed.startsWith("> ")) {
      nodes.push(<div key={`md-quote-${key++}`} style={blockStyles.quote}>{renderMarkdownInline(trimmed.slice(2), `quote-${key}`)}</div>);
      continue;
    }
    nodes.push(<div key={`md-p-${key++}`} style={blockStyles.p}>{renderMarkdownInline(trimmed, `p-${key}`)}</div>);
  }

  if (inCode) flushCode();
  return nodes;
}

/* ═══════════════════════════════════════════════════════════
   SNAKE FACTORY
   ═══════════════════════════════════════════════════════════ */
function makeSnake(x, y, colorIdx, context = [], task = null, config = {}) {
  const segs = Array.from({ length: BASE_SEGMENTS + context.length * 2 }, (_, i) => ({ x: x - i * SEG_GAP, y }));
  return {
    id: uid(),
    name: config.name || `Agent ${PALETTES[colorIdx % PALETTES.length].name}`,
    colorIdx, segments: segs, context: [...context],
    waypoint: null, leash: null, targetBubble: null,
    alive: true, speed: SNAKE_SPEED,
    spawnAnim: 1.0, mergeAnim: 0, autoSeek: config.autoSeek ?? (!!task || !!config.parentId),
    shedding: false, task,
    scentTrail: null,
    pendingThink: 0, isThinking: false,
    pendingMerge: null,
    // per-agent LLM config
    model: config.model || DEFAULT_MODEL,
    apiKey: config.apiKey || "",
    apiBase: normalizeApiBase(config.apiBase || DEFAULT_API_BASE),
    // hierarchy
    parentId: config.parentId || null,
    childIds: [],
    depth: config.depth || 0, // 0 = root, 1 = child, 2 = grandchild
    // sub-agent lifecycle
    thinkCount: 0,
    lastActivityTime: Date.now(),
    // human steering during research
    _steeringNotes: [],  // text typed mid-research
    _humanPins: [],      // bubble IDs clicked mid-research
  };
}

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════ */
export default function SnakeAgent() {
  const canvasRef = useRef(null);
  const inputRef = useRef(null);
  const tick = useRef(0);
  const savedCfg = useRef(Storage.loadApiConfig());

  const S = useRef({
    snakes: [makeSnake(MAP_W / 2, MAP_H / 2, 0, [], null, {
      model: savedCfg.current.model || DEFAULT_MODEL,
      apiKey: savedCfg.current.apiKey || "",
      apiBase: savedCfg.current.apiBase || DEFAULT_API_BASE,
    })],
    bubbles: [],
    selectedSnake: null,
    dragBubble: null, dragOffset: { x: 0, y: 0 }, _dragMoved: false, _dragStartPos: null,
    mergeCandidateId: null,
    camera: { x: MAP_W / 2, y: MAP_H / 2 },
    cameraMode: "follow",
    mouse: { x: 0, y: 0 }, mouseWorld: { x: 0, y: 0 },
    hoverBubble: null, hoverSnake: null,
    hoverStartTime: 0, previewBubbleId: null,
    expandedBubbleId: null, expandedScroll: 0,
    expandedSnakeId: null,
    selectedBubbles: new Set(),
    trash: [],
    dragToTrash: false,
    notifications: [],
    pendingDigests: [],
    particles: [], nextColor: 1,
    isPanning: false, panStart: { x: 0, y: 0 }, camStart: { x: 0, y: 0 },
    compressionQueue: [],
    imageCache: {},
    results: [],
    activeResultId: null,
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [trashHover, setTrashHover] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [configOpen, setConfigOpen] = useState(null);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const [mapName, setMapName] = useState(() => Storage.loadLastMap() || createDraftSessionName());
  const [lastPersistedAt, setLastPersistedAt] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [uiVersion, rerender] = useState(0);

  const hasSessionContent = useCallback((state = S.current) => (
    (state.bubbles || []).some(b => !b.isOnboarding) || state.snakes?.some(sn => sn.context.length > 0)
  ), []);

  function persistMapState(name, options = {}) {
    const { notify = false, notificationText = null } = options;
    const s = S.current;
    const currentName = normalizeSessionName(name) || createDraftSessionName();
    const baseName = isPlaceholderSessionName(currentName) ? deriveSessionName(s) : currentName;
    const targetName = makeUniqueSessionName(baseName, currentName);
    Storage.saveMap(targetName, s);
    if (targetName !== currentName && isPlaceholderSessionName(currentName) && Storage.listMaps().includes(currentName)) {
      Storage.deleteMap(currentName);
    }
    Storage.saveLastMap(targetName);
    setMapName(targetName);
    const primary = s.snakes.find(sn => sn.alive);
    if (primary) Storage.saveApiConfig({ model: primary.model, apiKey: primary.apiKey, apiBase: primary.apiBase });
    const persistedAt = Date.now();
    setLastPersistedAt(persistedAt);
    if (notify) {
      s.notifications.push({
        id: uid(),
        text: notificationText || `Session cached: ${targetName}`,
        bubbleId: null,
        snakeColorIdx: 0,
        createdAt: persistedAt,
      });
      rerender(n => n + 1);
    }
    return targetName;
  }

  // auto-save every 30s
  useEffect(() => {
    const iv = setInterval(() => {
      const s = S.current;
      if (hasSessionContent(s)) persistMapState(mapName);
      const primary = s.snakes.find(sn => sn.alive);
      if (primary) Storage.saveApiConfig({ model: primary.model, apiKey: primary.apiKey, apiBase: primary.apiBase });
    }, 30000);
    return () => clearInterval(iv);
  }, [hasSessionContent, mapName]);

  useEffect(() => {
    const flushToStorage = () => {
      const s = S.current;
      if (hasSessionContent(s)) {
        const currentName = normalizeSessionName(mapName) || createDraftSessionName();
        const baseName = isPlaceholderSessionName(currentName) ? deriveSessionName(s) : currentName;
        const targetName = makeUniqueSessionName(baseName, currentName);
        Storage.saveMap(targetName, s);
        if (targetName !== currentName && isPlaceholderSessionName(currentName) && Storage.listMaps().includes(currentName)) {
          Storage.deleteMap(currentName);
        }
        Storage.saveLastMap(targetName);
      }
      const primary = s.snakes.find(sn => sn.alive);
      if (primary) Storage.saveApiConfig({ model: primary.model, apiKey: primary.apiKey, apiBase: primary.apiBase });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushToStorage();
    };
    window.addEventListener("pagehide", flushToStorage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushToStorage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasSessionContent, mapName]);

  // load saved map on mount
  useEffect(() => {
    const last = Storage.loadLastMap();
    if (last) { const d = Storage.loadMap(last); if (d) loadMapData(d); }
  }, []);

  // auto-refresh debug/log panels
  useEffect(() => {
    if (!logOpen && !debugOpen) return;
    const iv = setInterval(() => rerender(n => n + 1), 800);
    return () => clearInterval(iv);
  }, [logOpen, debugOpen]);

  useEffect(() => {
    if (syncByokOnboarding(S.current)) rerender(n => n + 1);
  }, [uiVersion]);

  useEffect(() => {
    const s = S.current;
    const candidateIds = [s.previewBubbleId, s.expandedBubbleId].filter(Boolean);
    if (!candidateIds.length) return;
    const candidateBubbles = candidateIds
      .map(id => s.bubbles.find(bubble => bubble.id === id))
      .filter(bubble => bubble?.sourceUrl);
    if (!candidateBubbles.length) return;

    let cancelled = false;
    (async () => {
      for (const bubble of candidateBubbles) {
        const previewMeta = await fetchSourcePreviewMetadata(bubble.sourceUrl, getPrimarySnake(S.current)?.apiBase || DEFAULT_API_BASE);
        if (cancelled || !previewMeta) continue;
        const before = JSON.stringify(bubble.sourceMeta || {});
        const nextMeta = {
          ...(bubble.sourceMeta || {}),
          ...previewMeta,
          previewImage: previewMeta.image || bubble.sourceMeta?.previewImage || "",
        };
        if (JSON.stringify(nextMeta) !== before) {
          bubble.sourceMeta = nextMeta;
          rerender(n => n + 1);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uiVersion]);

  function loadMapData(data) {
    const s = S.current;
    const cfg = Storage.loadApiConfig();
    s.bubbles = (data.bubbles || []).map(b => ({ ...b, pulseAnim: 0, readers: b.readers || [], createdAt: b.createdAt || Date.now(), humanRead: b.humanRead !== false }));
    if (data.snakes?.length > 0) {
      s.snakes = data.snakes.map(sn => {
        const migratedCfg = migrateStoredApiConfig({ model: sn.model, apiKey: sn.apiKey, apiBase: sn.apiBase });
        const snake = makeSnake(sn.headX, sn.headY, sn.colorIdx, sn.context || [], sn.task, {
          model: migratedCfg.model || cfg.model || DEFAULT_MODEL,
          apiKey: migratedCfg.apiKey || cfg.apiKey || "", apiBase: migratedCfg.apiBase || cfg.apiBase || DEFAULT_API_BASE,
          parentId: sn.parentId, depth: sn.depth || 0, name: sn.name, autoSeek: sn.autoSeek,
        });
        snake.id = sn.id; snake.childIds = sn.childIds || [];
        return snake;
      });
      s.nextColor = Math.max(...s.snakes.map(sn => sn.colorIdx)) + 1;
    }
    if (data.camera) s.camera = { ...data.camera };
    s.selectedSnake = null; s.expandedBubbleId = null; s.expandedSnakeId = null;
    s.notifications = []; s.trash = []; s.results = []; s.activeResultId = null;
    setLastPersistedAt(data.savedAt || 0);
    rerender(n => n + 1);
  }

  function saveCurrentMap(name) {
    return persistMapState(name, { notify: true, notificationText: `Session cached: ${normalizeSessionName(name) || deriveSessionName(S.current)}` });
  }

  function newMap() {
    const s = S.current;
    if (hasSessionContent(s)) persistMapState(mapName);
    const cfg = Storage.loadApiConfig();
    s.bubbles = []; s.snakes = [makeSnake(MAP_W / 2, MAP_H / 2, 0, [], null, { model: cfg.model || DEFAULT_MODEL, apiKey: cfg.apiKey || "", apiBase: cfg.apiBase || DEFAULT_API_BASE })];
    s.camera = { x: MAP_W / 2, y: MAP_H / 2 }; s.selectedSnake = null; s.expandedBubbleId = null;
    s.trash = []; s.notifications = []; s.pendingDigests = []; s.nextColor = 1; s.results = []; s.activeResultId = null;
    setMapName(createDraftSessionName()); setLastPersistedAt(0); rerender(n => n + 1);
  }

  function persistSnakeConfig(sn) {
    Storage.saveApiConfig({
      model: sn.model || DEFAULT_MODEL,
      apiKey: sn.apiKey || "",
      apiBase: normalizeApiBase(sn.apiBase || DEFAULT_API_BASE),
    });
  }

  function applyProviderSelection(sn, provider) {
    const preset = getProviderPreset(provider);
    sn.apiBase = preset.apiBase;
    if (!preset.models.some(m => m.value === sn.model)) sn.model = preset.defaultModel;
    persistSnakeConfig(sn);
  }

  /* ── resize ── */
  useEffect(() => {
    const fn = () => {
      const c = canvasRef.current; if (!c) return;
      const d = window.devicePixelRatio || 1;
      const w = c.parentElement.clientWidth, h = c.parentElement.clientHeight;
      c.width = w * d; c.height = h * d;
      c.style.width = w + "px"; c.style.height = h + "px";
    };
    fn(); window.addEventListener("resize", fn); return () => window.removeEventListener("resize", fn);
  }, []);

  /* ── file drop ── */
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const prevent = e => e.preventDefault();

    const readFile = (file) => new Promise(resolve => {
      if (isImageFile(file.name)) {
        const reader = new FileReader();
        reader.onload = () => resolve({ text: `[Image: ${file.name}]`, dataUrl: reader.result });
        reader.readAsDataURL(file);
      } else if (isTextFile(file.name) || file.type.startsWith("text/")) {
        const reader = new FileReader();
        reader.onload = () => resolve({ text: reader.result.slice(0, 4000) });
        reader.readAsText(file);
      } else {
        resolve({ text: `[Binary: ${file.name}, ${(file.size/1024).toFixed(1)}KB]` });
      }
    });

    const onDrop = async (e) => {
      e.preventDefault();
      const s = S.current;
      const rect = c.getBoundingClientRect();
      const wx = e.clientX - rect.left + s.camera.x - rect.width / 2;
      const wy = e.clientY - rect.top + s.camera.y - rect.height / 2;

      // handle DataTransferItemList for folders
      const items = e.dataTransfer.items;
      const files = [];

      if (items) {
        for (const item of items) {
          if (item.kind === "file") {
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory) {
              await readDirectory(entry, files, "");
            } else {
              const f = item.getAsFile();
              if (f) files.push({ file: f, path: f.name });
            }
          }
        }
      } else {
        for (const f of e.dataTransfer.files) files.push({ file: f, path: f.name });
      }

      // layout files in a well-spaced grid near drop point
      const cols = Math.min(Math.ceil(Math.sqrt(files.length)), 8);
      const spacingX = 130, spacingY = 110;
      const gridW = cols * spacingX, gridH = Math.ceil(files.length / cols) * spacingY;
      for (let i = 0; i < files.length; i++) {
        const { file, path } = files[i];
        const col = i % cols, row = Math.floor(i / cols);
        const bx = wx + col * spacingX - gridW / 2 + spacingX / 2;
        const by = wy + row * spacingY - gridH / 2 + spacingY / 2;
        const data = await readFile(file);
        const ft = getFileType(path);
        const b = makeBubble(data.text, path, "file", "file", clamp(bx, 80, MAP_W - 80), clamp(by, 80, MAP_H - 80), {
          fileName: path, fileSize: file.size, fileType: ft,
        });
        if (data.dataUrl) {
          b.imageDataUrl = data.dataUrl;
          // pre-load as Image for canvas
          const img = new Image();
          img.src = data.dataUrl;
          s.imageCache[b.id] = img;
        }
        s.bubbles.push(b);
      }
      rerender(n => n + 1);
    };

    async function readDirectory(entry, results, prefix) {
      const reader = entry.createReader();
      const entries = await new Promise(r => reader.readEntries(r));
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__" || e.name === ".git") continue;
        if (e.isFile) {
          const file = await new Promise(r => e.file(r));
          results.push({ file, path: prefix ? `${prefix}/${e.name}` : e.name });
        } else if (e.isDirectory) {
          await readDirectory(e, results, prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
    }

    c.addEventListener("dragover", prevent);
    c.addEventListener("drop", onDrop);
    return () => { c.removeEventListener("dragover", prevent); c.removeEventListener("drop", onDrop); };
  }, []);

  /* ── mouse ── */
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const toWorld = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left + S.current.camera.x - r.width / 2, y: e.clientY - r.top + S.current.camera.y - r.height / 2 };
    };

    const toggleResultPanel = (bubble, s) => {
      if (!bubble?.isResult || !bubble.resultId) return false;
      bubble.humanRead = true;
      s.activeResultId = s.activeResultId === bubble.resultId ? null : bubble.resultId;
      rerender(n => n + 1);
      return true;
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      const w = toWorld(e); const s = S.current;
      const hitBubble = pickBubbleAtPoint(s, w, { preferResults: true, preferActiveResult: true });
      s.previewBubbleId = null;
      setCtxMenu(null);
      setConfigOpen(null);

      // any click cancels pending merges
      let hadMerge = false;
      for (const sn of s.snakes) {
        if (sn.pendingMerge) { sn.pendingMerge = null; hadMerge = true; }
      }
      if (hadMerge) { rerender(n => n + 1); return; }
      if (s.expandedBubbleId) {
        const eb = s.bubbles.find(b => b.id === s.expandedBubbleId);
        if (!eb || dist(w, eb) > 200) { s.expandedBubbleId = null; rerender(n => n + 1); }
      }
      if (s.expandedSnakeId) {
        const esn = s.snakes.find(sn => sn.id === s.expandedSnakeId);
        if (!esn || dist(w, esn.segments[0]) > 220) { s.expandedSnakeId = null; rerender(n => n + 1); }
      }
      // bubble click
      if (hitBubble) {
        const b = hitBubble;
        if (b.settled) b.litUntil = Date.now() + 6000;
        // pin bubble during research — human says "look at this"
        const selSnake = s.snakes.find(sn => sn.id === s.selectedSnake && sn.alive);
        if (selSnake && selSnake._researchPhase && !b.isResult) {
          if (!selSnake._humanPins.includes(b.id)) {
            selSnake._humanPins.push(b.id);
            b.litUntil = Date.now() + 8000;
            b._pinned = true;
            s.notifications.push({
              id: uid(), text: `📌 Pinned "${truncate(bubbleSummary(b), 20)}" — will factor into reflection`,
              bubbleId: b.id, snakeColorIdx: selSnake.colorIdx, createdAt: Date.now(),
            });
            rerender(n => n + 1);
          }
        }
        if (e.shiftKey) {
          // multi-select toggle
          if (s.selectedBubbles.has(b.id)) s.selectedBubbles.delete(b.id);
          else s.selectedBubbles.add(b.id);
          rerender(n => n + 1);
          return;
        }
        // start drag (if selected group, drag all)
        s.dragBubble = b.id; s.dragOffset = { x: b.x - w.x, y: b.y - w.y };
        s._dragStartPos = { x: b.x, y: b.y }; s._dragMoved = false;
        s.dragToTrash = false;
        setDragging(true);
        return;
      }
      // snake select
      for (const sn of s.snakes) {
        if (sn.alive && dist(w, sn.segments[0]) < 26) { s.selectedSnake = sn.id; s.cameraMode = "follow"; rerender(n => n + 1); return; }
      }
      // click empty space → clear selections
      if (!e.shiftKey) { s.selectedBubbles.clear(); }
      if (s.selectedSnake) { s.selectedSnake = null; rerender(n => n + 1); }
      s.isPanning = true; s.panStart = { x: e.clientX, y: e.clientY }; s.camStart = { ...s.camera };
      s.cameraMode = "free";
    };

    const onContext = (e) => {
      e.preventDefault();
      const w = toWorld(e); const s = S.current;
      const rect = canvasRef.current.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      // right-click anywhere cancels pending merges
      let hadMerge = false;
      for (const sn of s.snakes) {
        if (sn.pendingMerge) { sn.pendingMerge = null; hadMerge = true; }
      }
      if (hadMerge) { rerender(n => n + 1); return; }

      // if a snake is selected, right-click means "go here", "merge", or "config"
      if (s.selectedSnake) {
        setCtxMenu(null);
        const snake = s.snakes.find(sn => sn.id === s.selectedSnake && sn.alive);
        if (!snake) return;

        // right-click the SELECTED snake itself → config popup
        if (dist(w, snake.segments[0]) < 30) {
          setConfigOpen(snake.id);
          return;
        }

        // right-click another snake → initiate merge
        for (const other of s.snakes) {
          if (other.id === snake.id || !other.alive) continue;
          if (dist(w, other.segments[0]) < 30) {
            const bigger = snake.context.length >= other.context.length ? snake : other;
            const smaller = snake.context.length >= other.context.length ? other : snake;
            bigger.pendingMerge = { targetSnakeId: smaller.id, role: "survivor" };
            smaller.pendingMerge = { targetSnakeId: bigger.id, role: "absorbed" };
            bigger.waypoint = null; bigger.leash = null; bigger.scentTrail = null;
            smaller.waypoint = null; smaller.leash = null; smaller.scentTrail = null;
            s.notifications.push({
              id: uid(), text: `Merging ${smaller.name} → ${bigger.name}… (Esc to cancel)`,
              bubbleId: null, snakeColorIdx: bigger.colorIdx, createdAt: Date.now(),
            });
            rerender(n => n + 1);
            return;
          }
        }

        // otherwise navigate
        snake.autoSeek = true;
        snake.waypoint = { x: w.x, y: w.y }; snake.leash = { x: w.x, y: w.y, radius: LEASH_RADIUS };
        snake.targetBubble = null;
        spawnP(w.x, w.y, PALETTES[snake.colorIdx % PALETTES.length].head + "44", 6);
        return;
      }

      // no snake selected — right-click on a snake → config popup
      for (const sn of s.snakes) {
        if (sn.alive && dist(w, sn.segments[0]) < 30) {
          setCtxMenu(null);
          setConfigOpen(sn.id);
          return;
        }
      }

      // no snake selected — right-click on bubble shows context menu
      const hitBubble = pickBubbleAtPoint(s, w, { preferResults: true, preferActiveResult: true });
      if (hitBubble) {
        setCtxMenu({ x: screenX, y: screenY, bubbleId: hitBubble.id });
        return;
      }

      setCtxMenu(null);
    };

    const onMove = (e) => {
      const w = toWorld(e); const s = S.current;
      const rect = canvasRef.current.getBoundingClientRect();
      s.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      s.mouseWorld = w;
      if (s.dragBubble) {
        const b = s.bubbles.find(b => b.id === s.dragBubble);
        if (b) {
          const dx = w.x + s.dragOffset.x - b.x, dy = w.y + s.dragOffset.y - b.y;
          b.x = w.x + s.dragOffset.x; b.y = w.y + s.dragOffset.y;
          if (dist(b, s._dragStartPos || b) > 8) s._dragMoved = true;
          // also move selected group
          if (s.selectedBubbles.has(b.id)) {
            for (const sid of s.selectedBubbles) {
              if (sid === b.id) continue;
              const sb = s.bubbles.find(b => b.id === sid);
              if (sb) { sb.x += dx; sb.y += dy; }
            }
          }
        }
        // detect merge candidate
        s.mergeCandidateId = null;
        const dragB = s.bubbles.find(b => b.id === s.dragBubble);
        if (dragB) {
          for (const o of s.bubbles) { if (o.id !== s.dragBubble && !s.selectedBubbles.has(o.id) && dist(dragB, o) < BUBBLE_MERGE_DRAG_DIST) { s.mergeCandidateId = o.id; break; } }
        }
        return;
      }
      if (s.isPanning) { s.camera.x = s.camStart.x - (e.clientX - s.panStart.x); s.camera.y = s.camStart.y - (e.clientY - s.panStart.y); return; }
      const prevHover = s.hoverBubble;
      const prevPreview = s.previewBubbleId;
      s.hoverBubble = null; s.hoverSnake = null;
      const hitBubble = pickBubbleAtPoint(s, w, { preferResults: true, preferActiveResult: true });
      if (hitBubble) s.hoverBubble = hitBubble.id;
      for (const sn of s.snakes) if (sn.alive && dist(w, sn.segments[0]) < 26) { s.hoverSnake = sn.id; break; }
      let shouldRefresh = false;
      if (s.hoverBubble !== prevHover) { s.hoverStartTime = Date.now(); s.previewBubbleId = null; shouldRefresh = true; }
      else if (s.hoverBubble && !s.previewBubbleId && Date.now() - s.hoverStartTime > 800) {
        s.previewBubbleId = s.hoverBubble;
        const hb = s.bubbles.find(b => b.id === s.hoverBubble);
        if (hb) hb.humanRead = true;
        shouldRefresh = true;
      }
      if (!s.hoverBubble && s.previewBubbleId) { s.previewBubbleId = null; shouldRefresh = true; }
      if (prevPreview !== s.previewBubbleId) shouldRefresh = true;
      if (shouldRefresh) rerender(n => n + 1);
    };

    const onUp = () => {
      const s = S.current;
      const clickedBubbleId = s.dragBubble;
      const wasClick = !!clickedBubbleId && !s._dragMoved && !s.dragToTrash && !s.mergeCandidateId;
      if (s.dragBubble) {
        if (s.dragToTrash) {
          const idsToTrash = new Set(
            s.selectedBubbles.has(s.dragBubble)
              ? [...s.selectedBubbles] : [s.dragBubble]
          );
          const trashed = s.bubbles.filter(b => idsToTrash.has(b.id));
          s.trash.push(...trashed);
          s.bubbles = s.bubbles.filter(b => !idsToTrash.has(b.id));
          s.selectedBubbles.clear();
        } else if (s.mergeCandidateId) {
          const src = s.bubbles.find(b => b.id === s.dragBubble);
          const tgt = s.bubbles.find(b => b.id === s.mergeCandidateId);
          if (src && tgt) { tgt.items.push(...src.items); tgt.readers = [...new Set([...tgt.readers, ...src.readers])]; tgt.pulseAnim = 0.6; s.bubbles = s.bubbles.filter(b => b.id !== src.id); spawnP(tgt.x, tgt.y, (CATS[bubbleCat(tgt)] || CATS.default).color, 8); }
        }
      }
      if (wasClick) {
        const clickedBubble = s.bubbles.find(b => b.id === clickedBubbleId);
        if (toggleResultPanel(clickedBubble, s)) {
          s.dragBubble = null; s.mergeCandidateId = null; s.isPanning = false; s.dragToTrash = false;
          setDragging(false); setTrashHover(false);
          return;
        }
      }
      s.dragBubble = null; s.mergeCandidateId = null; s.isPanning = false; s.dragToTrash = false;
      setDragging(false); setTrashHover(false);
      rerender(n => n + 1);
    };

    const onWheel = (e) => {
      e.preventDefault();
      const s = S.current;
      const mx = s.mouse?.x || 0, my = s.mouse?.y || 0;
      const W = canvasRef.current?.parentElement?.clientWidth || 800;
      const H = canvasRef.current?.parentElement?.clientHeight || 600;

      // scroll expanded bubble card
      if (s.expandedBubbleId) {
        const b = s.bubbles.find(b => b.id === s.expandedBubbleId);
        if (b) {
          const bsx = b.x - s.camera.x + W / 2, bsy = b.y - s.camera.y + H / 2;
          if (Math.abs(mx - bsx) < 200 && Math.abs(my - bsy) < 200) {
            s.expandedScroll = Math.max(0, (s.expandedScroll || 0) + e.deltaY * 0.6);
            return;
          }
        }
      }
      // scroll expanded snake card
      if (s.expandedSnakeId) {
        const sn = s.snakes.find(sn => sn.id === s.expandedSnakeId);
        if (sn) {
          const hx = sn.segments[0].x - s.camera.x + W / 2, hy = sn.segments[0].y - s.camera.y + H / 2;
          if (Math.abs(mx - hx) < 200 && Math.abs(my - hy) < 200) {
            s.expandedScroll = Math.max(0, (s.expandedScroll || 0) + e.deltaY * 0.6);
            return;
          }
        }
      }
      s.camera.x += e.deltaX * 0.8; s.camera.y += e.deltaY * 0.8;
      s.cameraMode = "free";
    };
    const onDbl = (e) => {
      const w = toWorld(e); const s = S.current;
      // double-click bubble → expand or open
      const hitBubble = pickBubbleAtPoint(s, w, { preferResults: true, preferActiveResult: true });
      if (hitBubble) {
        const b = hitBubble;
        b.humanRead = true;
        // result bubbles → open result panel
        if (toggleResultPanel(b, s)) return;
        // source bubbles → open URL in new tab
        if (b.sourceUrl) {
          try { window.open(b.sourceUrl, "_blank"); } catch {}
          return;
        }
        s.expandedBubbleId = s.expandedBubbleId === b.id ? null : b.id;
        s.expandedSnakeId = null;
        s.expandedScroll = 0;
        rerender(n => n + 1);
        return;
      }
      // double-click snake → show context
      for (const sn of s.snakes) {
        if (sn.alive && dist(w, sn.segments[0]) < 26) {
          s.expandedSnakeId = s.expandedSnakeId === sn.id ? null : sn.id;
          s.expandedBubbleId = null;
          s.expandedScroll = 0;
          rerender(n => n + 1);
          return;
        }
      }
      // close any expanded card
      if (s.expandedBubbleId || s.expandedSnakeId) { s.expandedBubbleId = null; s.expandedSnakeId = null; rerender(n => n + 1); return; }
      const sel = s.snakes.find(sn => sn.id === s.selectedSnake);
      if (sel) {
        sel.leash = null;
        sel.waypoint = null;
        sel.targetBubble = null;
        sel.autoSeek = false;
        rerender(n => n + 1);
      }
    };

    c.addEventListener("mousedown", onDown); c.addEventListener("mousemove", onMove);
    c.addEventListener("mouseup", onUp); c.addEventListener("mouseleave", onUp);
    c.addEventListener("wheel", onWheel, { passive: false }); c.addEventListener("dblclick", onDbl);
    c.addEventListener("contextmenu", onContext);

    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const s = S.current;
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedBubbles.size > 0) {
        e.preventDefault();
        const trashed = s.bubbles.filter(b => s.selectedBubbles.has(b.id));
        s.trash.push(...trashed);
        s.bubbles = s.bubbles.filter(b => !s.selectedBubbles.has(b.id));
        s.selectedBubbles.clear();
        rerender(n => n + 1);
      }
      if (e.key === "Escape") {
        if (debugOpen) { setDebugOpen(false); return; }
        s.selectedBubbles.clear();
        s.expandedBubbleId = null;
        s.expandedSnakeId = null;
        s.selectedSnake = null;
        setConfigOpen(null);
        for (const sn of s.snakes) {
          if (sn.pendingMerge) sn.pendingMerge = null;
        }
        rerender(n => n + 1);
      }
      // Ctrl+A to select all bubbles
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        for (const b of s.bubbles) s.selectedBubbles.add(b.id);
        rerender(n => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      c.removeEventListener("mousedown", onDown); c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseup", onUp); c.removeEventListener("mouseleave", onUp);
      c.removeEventListener("wheel", onWheel); c.removeEventListener("dblclick", onDbl);
      c.removeEventListener("contextmenu", onContext); window.removeEventListener("keydown", onKey);
    };
  }, []);

  function spawnP(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      S.current.particles.push({ x, y, vx: Math.cos(a) * (1 + Math.random() * 2.5), vy: Math.sin(a) * (1 + Math.random() * 2.5), life: 1, color, r: 2 + Math.random() * 2.5 });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     CONTEXT SHEDDING — compress oldest context into memory bubble
     ═══════════════════════════════════════════════════════════ */
  async function shedContext(snake) {
    if (snake.shedding || snake.context.length <= MAX_CONTEXT) return;
    snake.shedding = true;
    const toCompress = snake.context.splice(0, COMPRESS_BATCH);
    const head = snake.segments[0];

    // get compression from LLM
    const result = await compressContext(toCompress, { model: snake.model, apiKey: snake.apiKey, apiBase: snake.apiBase });

    // place memory bubble behind the snake (near tail)
    const tail = snake.segments[snake.segments.length - 1];
    const pos = placeBubble(result.text, S.current.bubbles, tail.x, tail.y);
    const mb = makeBubble(result.text, result.summary, "memory", "system", pos.x, pos.y, { isMemory: true });
    mb.compressedFrom = toCompress.length;
    mb.readers.push(snake.id);
    S.current.bubbles.push(mb);

    // particles from tail — shedding effect
    for (let i = 0; i < 16; i++) {
      const t = tail;
      const col = PALETTES[snake.colorIdx % PALETTES.length];
      S.current.particles.push({
        x: t.x + (Math.random() - 0.5) * 20, y: t.y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3,
        life: 1.2, color: col.body, r: 3 + Math.random() * 3,
      });
    }

    snake.shedding = false;
    rerender(n => n + 1);
  }

  /* ═══════════════════════════════════════════════════════════
     MAIN LOOP
     ═══════════════════════════════════════════════════════════ */
  useEffect(() => {
    let raf;
    const loop = () => {
      tick.current++;
      const s = S.current;
      const canvas = canvasRef.current;
      if (!canvas) { raf = requestAnimationFrame(loop); return; }
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.width / dpr, H = canvas.height / dpr;

      /* ── UPDATE ── */
      for (const sn of s.snakes) {
        if (!sn.alive) continue;
        const head = sn.segments[0];
        if (sn.spawnAnim > 0) sn.spawnAnim = Math.max(0, sn.spawnAnim - 0.02);

        // segment count tracks context
        const desired = BASE_SEGMENTS + sn.context.length * 2;
        if (sn.segments.length < desired) { const t = sn.segments[sn.segments.length - 1]; sn.segments.push({ x: t.x, y: t.y }); }
        else if (sn.segments.length > desired + 2) sn.segments.pop();

        // context shedding check
        if (sn.context.length > MAX_CONTEXT && !sn.shedding) shedContext(sn);

        // targeting
        let target = null;
        let speedMult = 1;

        // PENDING MERGE: highest priority — navigate toward merge partner
        if (sn.pendingMerge) {
          const partner = s.snakes.find(o => o.id === sn.pendingMerge.targetSnakeId);
          if (!partner || !partner.alive || !partner.pendingMerge) {
            // partner gone or cancelled
            sn.pendingMerge = null;
          } else {
            const partnerHead = partner.segments[0];
            // both navigate toward midpoint
            const midX = (head.x + partnerHead.x) / 2;
            const midY = (head.y + partnerHead.y) / 2;
            target = { x: midX, y: midY };
            speedMult = 0.6;

            // check if close enough to actually merge
            if (dist(head, partnerHead) < 25) {
              if (sn.pendingMerge.role === "survivor") {
                const absorbed = partner;
                sn.pendingMerge = null;
                absorbed.pendingMerge = null;
                performSmartMerge(sn, absorbed);
              }
              // absorbed snake just waits — survivor triggers the merge
            }
          }
        }

        // scent trail: highest priority auto-seek (after merge)
        if (!target && sn.scentTrail) {
          const st = sn.scentTrail;
          const age = tick.current - st.startTick;
          if (age > SCENT_FADE_TIME) {
            sn.scentTrail = null; // expired
          } else {
            // find nearest unread scent match
            let best = null, bestD = Infinity;
            for (const mid of st.matchIds) {
              const b = s.bubbles.find(b => b.id === mid);
              if (!b || b.readers.includes(sn.id)) continue;
              const d = dist(head, b);
              if (d < bestD) { bestD = d; best = b; }
            }
            if (best) {
              target = best;
              sn.targetBubble = best.id;
              speedMult = SCENT_SPEED_MULT;
            } else {
              sn.scentTrail = null; // all matches read
            }
          }
        }

        if (!target && sn.waypoint) {
          target = sn.waypoint;
          if (dist(head, sn.waypoint) < 15) sn.waypoint = null;
        } else if (!target && sn.autoSeek) {
          let best = null, bestD = Infinity;
          for (const b of s.bubbles) {
            if (b.readers.includes(sn.id)) continue;
            if (!b.autoSeekable) continue;
            const d = dist(head, b);
            if (sn.leash) {
              if (dist(sn.leash, b) > sn.leash.radius) continue;
            } else {
              if (d > PERCEPTION_RADIUS) continue;
            }
            if (d < bestD) { bestD = d; best = b; }
          }
          if (best) { target = best; sn.targetBubble = best.id; }
          else if (sn.leash) {
            const t = tick.current * 0.012 + parseInt(sn.id, 36) * 0.5;
            target = { x: sn.leash.x + Math.cos(t) * sn.leash.radius * 0.3, y: sn.leash.y + Math.sin(t) * sn.leash.radius * 0.3 };
          }
        }
        if (target) {
          const a = Math.atan2(target.y - head.y, target.x - head.x);
          head.x += Math.cos(a) * sn.speed * speedMult;
          head.y += Math.sin(a) * sn.speed * speedMult;
        } else {
          const t = tick.current * 0.008 + parseInt(sn.id, 36) * 0.1;
          head.x += Math.cos(t) * 0.35; head.y += Math.sin(t * 0.7) * 0.35;
        }
        head.x = clamp(head.x, 20, MAP_W - 20); head.y = clamp(head.y, 20, MAP_H - 20);

        // chain
        for (let i = 1; i < sn.segments.length; i++) {
          const p = sn.segments[i - 1], sg = sn.segments[i];
          const d = dist(p, sg);
          if (d > SEG_GAP) { const r = SEG_GAP / d; sg.x = p.x + (sg.x - p.x) * r; sg.y = p.y + (sg.y - p.y) * r; }
        }

        // READ — only intentional targets, not accidental drive-bys
        for (const b of s.bubbles) {
          if (b.readers.includes(sn.id)) continue;
          if (dist(head, b) < READ_DIST) {
            const isTarget = sn.targetBubble === b.id;
            const isScentMatch = sn.scentTrail && sn.scentTrail.matchIds.includes(b.id);
            const isWaypointTarget = sn.waypoint && dist(sn.waypoint, b) < READ_DIST * 2;
            if (!isTarget && !isScentMatch && !isWaypointTarget) continue;

            b.readers.push(sn.id); b.pulseAnim = 0.5;
            spawnP(b.x, b.y, PALETTES[sn.colorIdx % PALETTES.length].body, 6);
            const isAutonomous = (isTarget || isScentMatch) && !isWaypointTarget;
            const isFile = !!b.fileType;

            if (isFile) {
              // FILE: queue for async digest — don't put raw content in context
              s.pendingDigests.push({
                snakeId: sn.id, bubbleId: b.id,
                fileName: b.fileName || "file",
                content: b.items.map(i => i.text).join("\n"),
                isAutonomous,
              });
            } else {
              // NON-FILE: store as-is (already compact conversation/analysis)
              for (const item of b.items) {
                sn.context.push({ role: item.role, content: item.text, summary: item.summary, category: item.category });
              }
              if (isAutonomous && !sn.isThinking) sn.pendingThink = Date.now();
            }
          }
        }

        // collision merge removed — merge is now intentional via right-click
      }

      // anims
      for (const b of s.bubbles) { if (b.pulseAnim > 0) b.pulseAnim = Math.max(0, b.pulseAnim - 0.02); }
      for (const sn of s.snakes) { if (!sn.alive && sn.mergeAnim > 0) sn.mergeAnim = Math.max(0, sn.mergeAnim - 0.03); }
      s.particles = s.particles.filter(p => { p.x += p.vx; p.y += p.vy; p.vx *= 0.95; p.vy *= 0.95; p.life -= 0.022; return p.life > 0; });

      // settled bubbles orbit their result parent
      for (const b of s.bubbles) {
        if (!b.settled || !b.resultParentId) continue;
        const parent = s.bubbles.find(p => p.id === b.resultParentId);
        if (!parent) continue;
        const orbitR = 80 + (parseInt(b.id, 36) % 60);
        const angle = tick.current * 0.003 + parseInt(b.id, 36) * 0.8;
        const tx = parent.x + Math.cos(angle) * orbitR;
        const ty = parent.y + Math.sin(angle) * orbitR * 0.6;
        b.x += (tx - b.x) * 0.008;
        b.y += (ty - b.y) * 0.008;
      }

      // camera — only follow in follow mode
      if (s.cameraMode === "follow") {
        const ct = s.snakes.find(sn => sn.id === s.selectedSnake && sn.alive) || s.snakes.find(sn => sn.alive);
        if (ct && !s.isPanning && !s.dragBubble) { const h = ct.segments[0]; s.camera.x += (h.x - s.camera.x) * 0.04; s.camera.y += (h.y - s.camera.y) * 0.04; }
      }

      /* ══════════════════════ RENDER ══════════════════════ */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#050510"; ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(-s.camera.x + W / 2, -s.camera.y + H / 2);

      // dots
      ctx.fillStyle = "#0c0c1e";
      const gs = 50, gx0 = Math.floor((s.camera.x - W / 2) / gs) * gs, gy0 = Math.floor((s.camera.y - H / 2) / gs) * gs;
      for (let x = gx0; x < s.camera.x + W / 2; x += gs) for (let y = gy0; y < s.camera.y + H / 2; y += gs)
        if (x >= 0 && x <= MAP_W && y >= 0 && y <= MAP_H) ctx.fillRect(x - 0.4, y - 0.4, 0.8, 0.8);

      // border
      ctx.strokeStyle = "#0e0e30"; ctx.lineWidth = 1; ctx.setLineDash([12, 8]); ctx.strokeRect(0, 0, MAP_W, MAP_H); ctx.setLineDash([]);

      // connections
      ctx.lineWidth = 0.5;
      for (let i = 0; i < s.bubbles.length; i++) for (let j = i + 1; j < s.bubbles.length; j++) {
        const a = s.bubbles[i], b = s.bubbles[j], d = dist(a, b);
        if (bubbleCat(a) === bubbleCat(b) && d < 300) { ctx.strokeStyle = (CATS[bubbleCat(a)] || CATS.default).color + "10"; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }

      /* ── BUBBLE NODES ── */
      for (const b of s.bubbles) {
        const cat = CATS[bubbleCat(b)] || CATS.default;
        const isHover = s.hoverBubble === b.id, isDrag = s.dragBubble === b.id, isDetail = s.expandedBubbleId === b.id;
        const isSelected = s.selectedBubbles.has(b.id);
        const isMergeTarget = s.mergeCandidateId === b.id;
        const isFile = !!b.fileType;
        const isMemory = !!b.isMemory;
        const isImage = !!b.imageDataUrl;
        const accentColor = isFile ? b.fileType.color : cat.color;
        const itemCount = b.items.length;
        const pulse = b.pulseAnim > 0 ? 1 + b.pulseAnim * 0.15 : 1;
        const isUnread = !b.humanRead && b.items[0].role === "assistant";
        const unreadAge = isUnread ? (Date.now() - b.createdAt) / 1000 : 99;
        const unreadGlow = isUnread ? Math.max(0, 1 - unreadAge / 15) : 0;
        const isResult = !!b.isResult;
        const isSource = !!b.sourceUrl;
        const isSettled = b.settled && !isResult;
        const isLit = b.litUntil && Date.now() < b.litUntil;
        const settledAlpha = isSettled ? (isLit ? 0.85 : isHover ? 0.9 : 0.2) : 1;
        if (isSettled && isHover && !isLit) b.litUntil = Date.now() + 4000;

        ctx.save(); ctx.translate(b.x, b.y);
        ctx.globalAlpha = settledAlpha;

        // scent match highlight — check if any snake's trail targets this bubble
        let isScentMatch = false;
        let scentColor = null;
        for (const sn of s.snakes) {
          if (sn.scentTrail && sn.scentTrail.matchIds.includes(b.id) && !b.readers.includes(sn.id)) {
            isScentMatch = true;
            scentColor = PALETTES[sn.colorIdx % PALETTES.length].head;
            break;
          }
        }
        if (isScentMatch) {
          const pulseR = 38 + Math.sin(tick.current * 0.08) * 4;
          ctx.strokeStyle = scentColor + "55";
          ctx.lineWidth = 2;
          ctx.shadowColor = scentColor + "44";
          ctx.shadowBlur = 14;
          ctx.beginPath(); ctx.arc(0, 0, pulseR, 0, Math.PI * 2); ctx.stroke();
          ctx.shadowBlur = 0;
        }

        // merge drop target ring
        if (isMergeTarget) {
          ctx.strokeStyle = "#ffffff55"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.roundRect(-42, -22, 84, 44, 14); ctx.stroke(); ctx.setLineDash([]);
        }

        // measure label
        const label = truncate(bubbleSummary(b), 20);
        ctx.font = "600 10px -apple-system, 'Segoe UI', sans-serif";
        const labelW = ctx.measureText(label).width;
        const iconStr = isFile ? b.fileType.icon : cat.icon;

        // pill dimensions — results are meta-bubbles, settled are compact
        const basePillH = isResult ? 52 : isSettled ? 22 : isSource ? 52 : 30;
        const basePillW = isResult ? Math.max(180, labelW + 70) : isSettled ? Math.max(44, labelW + 24) : isSource ? Math.max(140, labelW + 44) : Math.max(60, labelW + 40);
        const pillH = basePillH * pulse;
        const pillW = basePillW * pulse;
        const px = -pillW / 2, py = -pillH / 2;

        // result glow — large, permanent animated shimmer
        if (isResult) {
          const shimmer = 0.5 + 0.5 * Math.sin(tick.current * 0.03);
          const haloR = pillW * 0.9 + shimmer * 20;
          const haloGrad = ctx.createRadialGradient(0, 0, pillW * 0.15, 0, 0, haloR);
          haloGrad.addColorStop(0, CATS.result.color + "22");
          haloGrad.addColorStop(0.5, CATS.result.color + "08");
          haloGrad.addColorStop(1, "transparent");
          ctx.fillStyle = haloGrad;
          ctx.fillRect(-haloR, -haloR, haloR * 2, haloR * 2);
          for (let ri = 0; ri < 2; ri++) {
            const rOff = ri * 8;
            ctx.strokeStyle = CATS.result.color + Math.round(20 + shimmer * 30 - ri * 10).toString(16).padStart(2, "0");
            ctx.lineWidth = 1.5 - ri * 0.5;
            ctx.setLineDash([10, 5]); ctx.lineDashOffset = -tick.current * (0.3 + ri * 0.15);
            ctx.beginPath(); ctx.roundRect(px - 8 - rOff, py - 8 - rOff, pillW + 16 + rOff * 2, pillH + 16 + rOff * 2, pillH / 2 + 8 + rOff); ctx.stroke();
          }
          ctx.setLineDash([]); ctx.lineDashOffset = 0;
          const childCount = s.bubbles.filter(c => c.resultParentId === b.id && c.settled).length;
          if (childCount > 0) {
            ctx.font = "8px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
            ctx.fillStyle = CATS.result.color + "55";
            ctx.fillText(`${childCount} sources`, 0, pillH / 2 + 12);
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
          }
        }

        // subtle shadow
        if (!isDrag) {
          ctx.shadowColor = isResult ? CATS.result.color + "88" : unreadGlow > 0 ? accentColor + "66" : accentColor + "25";
          ctx.shadowBlur = isResult ? 20 : unreadGlow > 0 ? 14 + unreadGlow * 10 : (isHover || isDetail) ? 16 : 6;
          ctx.shadowOffsetY = isResult ? 4 : 2;
        }

        // pill background
        ctx.fillStyle = isResult ? "#0c1a0c" : unreadGlow > 0 ? "#12122a" : (isHover || isDetail) ? "#141422" : "#0e0e1a";
        ctx.strokeStyle = isSelected ? "#4488ff88"
          : isResult ? CATS.result.color + "88"
          : unreadGlow > 0 ? accentColor + Math.round(40 + unreadGlow * 50).toString(16)
          : (isHover || isDetail || isDrag) ? accentColor + "88" : "#1a1a30";
        ctx.lineWidth = isResult ? 1.5 : unreadGlow > 0 ? 1.4 : isSelected ? 1.5 : (isHover || isDetail) ? 1.2 : 0.7;
        ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, pillH / 2); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // unread dot
        if (isUnread && unreadGlow > 0) {
          const dotPulse = 0.7 + 0.3 * Math.sin(tick.current * 0.06);
          ctx.fillStyle = accentColor;
          ctx.globalAlpha = unreadGlow * dotPulse;
          ctx.beginPath(); ctx.arc(px - 6, 0, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }

        // human pin indicator
        if (b._pinned) {
          ctx.font = "10px -apple-system, sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillStyle = "#5ce0d8";
          ctx.fillText("📌", 0, py - 4);
        }

        // selection highlight
        if (isSelected) {
          ctx.strokeStyle = "#4488ff44";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.roundRect(px - 4, py - 4, pillW + 8, pillH + 8, pillH / 2 + 4); ctx.stroke();
          ctx.setLineDash([]);
        }

        // left accent bar
        ctx.save();
        ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, pillH / 2); ctx.clip();
        ctx.fillStyle = accentColor + (isMemory ? "55" : "44");
        ctx.fillRect(px, py, 4, pillH);
        ctx.restore();

        // icon & label
        if (isSettled && !isLit && !isHover) {
          ctx.fillStyle = accentColor + "44";
          ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.font = `${isResult ? 18 : isFile ? 11 : 12}px -apple-system, sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = accentColor;
          ctx.fillText(iconStr, px + (isResult ? 24 : 16), isSource && !isSettled ? -8 : 0);
          ctx.font = isResult ? "bold 13px -apple-system, 'Segoe UI', sans-serif" : "600 10px -apple-system, 'Segoe UI', sans-serif";
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillStyle = isResult ? CATS.result.color : "#b0b0c4";
          ctx.fillText(isResult ? truncate(b.resultTitle || label, 28) : label, px + (isResult ? 40 : 28), isSource && !isSettled ? -8 : 0);
          if (isResult) {
            ctx.font = "9px -apple-system, sans-serif"; ctx.fillStyle = "#556";
            ctx.fillText("Click to open full report", px + 40, 14);
          }
          if (isSource && !isSettled) {
            const domain = b.sourceDomain || "";
            const snippet = truncate(b.sourceSnippet || "", 50);
            ctx.font = "bold 8px -apple-system, sans-serif"; ctx.fillStyle = CATS.source.color + "99";
            ctx.fillText(domain, px + 28, 6);
            if (snippet) { ctx.font = "8px -apple-system, sans-serif"; ctx.fillStyle = "#667"; ctx.fillText(snippet, px + 28, 17); }
          }
        }

        // stack count badge (top right)
        if (itemCount > 1) {
          const bx = pillW / 2 - 2, by = -pillH / 2 - 2;
          ctx.fillStyle = accentColor; ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
          ctx.font = "bold 7.5px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#000"; ctx.fillText(String(itemCount), bx, by);
        }

        // memory indicator
        if (isMemory && b.compressedFrom) {
          ctx.font = "7px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
          ctx.fillStyle = "#dd88ff44";
          ctx.fillText(`${b.compressedFrom} msgs compressed`, 0, pillH / 2 + 4);
        }

        // reader dots (below pill)
        if (b.readers.length > 0) {
          const dotY = pillH / 2 + (isMemory && b.compressedFrom ? 16 : 6);
          const totalDotsW = b.readers.length * 10;
          b.readers.forEach((rid, ri) => {
            const sn = s.snakes.find(sn => sn.id === rid);
            if (!sn) return;
            const col = PALETTES[sn.colorIdx % PALETTES.length];
            const dx = -totalDotsW / 2 + ri * 10 + 5;
            ctx.fillStyle = col.body;
            ctx.beginPath(); ctx.arc(dx, dotY, 3, 0, Math.PI * 2); ctx.fill();
          });
        }

        // result star particles (floating)
        if (isResult) {
          const t = tick.current * 0.02;
          for (let i = 0; i < 4; i++) {
            const angle = t + i * Math.PI / 2;
            const r = pillW * 0.45 + Math.sin(t * 2 + i) * 6;
            const sx = Math.cos(angle) * r;
            const sy = Math.sin(angle) * r * 0.5;
            ctx.globalAlpha = 0.3 + 0.3 * Math.sin(t * 3 + i);
            ctx.fillStyle = CATS.result.color;
            ctx.font = "8px -apple-system, sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("✦", sx, sy);
          }
          ctx.globalAlpha = 1;
        }

        // image thumbnail badge (small square next to pill)
        if (isImage && s.imageCache[b.id]) {
          const thumbS = 22;
          const tx = pillW / 2 + 6, ty = -thumbS / 2;
          ctx.save();
          ctx.beginPath(); ctx.roundRect(tx, ty, thumbS, thumbS, 4); ctx.clip();
          try { ctx.drawImage(s.imageCache[b.id], tx, ty, thumbS, thumbS); } catch {}
          ctx.restore();
          ctx.strokeStyle = "#1a1a30"; ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.roundRect(tx, ty, thumbS, thumbS, 4); ctx.stroke();
        }

        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.restore();
      }

      /* ── PARENT-CHILD LINES ── */
      for (const sn of s.snakes) {
        if (!sn.alive || !sn.parentId) continue;
        const parent = s.snakes.find(p => p.id === sn.parentId && p.alive);
        if (!parent) continue;
        const h = sn.segments[0], ph = parent.segments[0];
        const col = PALETTES[sn.colorIdx % PALETTES.length];
        ctx.strokeStyle = col.body + "18";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(ph.x, ph.y); ctx.stroke();
        ctx.setLineDash([]);
      }

      /* ── SCENT TRAILS ── */
      for (const sn of s.snakes) {
        if (!sn.scentTrail || !sn.alive) continue;
        const st = sn.scentTrail;
        const col = PALETTES[sn.colorIdx % PALETTES.length];
        const age = tick.current - st.startTick;
        const fadeAlpha = Math.max(0, 1 - age / SCENT_FADE_TIME);
        const head = sn.segments[0];

        // expanding ripple (first ~60 ticks)
        if (age < 60) {
          const rippleR = age * 12;
          const rippleAlpha = (1 - age / 60) * 0.3 * fadeAlpha;
          ctx.strokeStyle = col.head;
          ctx.globalAlpha = rippleAlpha;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(st.originX || head.x, st.originY || head.y, rippleR, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // scent lines to each unread match
        for (const mid of st.matchIds) {
          const b = s.bubbles.find(b => b.id === mid);
          if (!b || b.readers.includes(sn.id)) continue;

          ctx.globalAlpha = fadeAlpha * 0.6;
          ctx.strokeStyle = col.head + "66";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([8, 6]);
          ctx.lineDashOffset = -tick.current * 0.8;
          ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]); ctx.lineDashOffset = 0;

          // floating particles along the line
          const dx = b.x - head.x, dy = b.y - head.y;
          const lineLen = Math.hypot(dx, dy);
          const particleCount = Math.min(5, Math.floor(lineLen / 80));
          for (let p = 0; p < particleCount; p++) {
            const t = ((tick.current * 0.006 + p * 0.2) % 1);
            const px = head.x + dx * t;
            const py = head.y + dy * t;
            const pAlpha = fadeAlpha * 0.5 * Math.sin(t * Math.PI);
            ctx.globalAlpha = pAlpha;
            ctx.fillStyle = col.head;
            ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }

      /* ── SNAKES ── */
      for (const sn of s.snakes) {
        if (!sn.alive && !sn.mergeAnim) continue;
        const col = PALETTES[sn.colorIdx % PALETTES.length];
        const alpha = sn.alive ? (sn.spawnAnim ? 1 - sn.spawnAnim : 1) : (sn.mergeAnim || 0);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        const isSelected = s.selectedSnake === sn.id;
        const isShedding = sn.shedding;
        // show merge hint if another snake is selected and mouse is near this snake's head
        const isMergeTarget = !isSelected && s.selectedSnake && sn.alive && s.hoverSnake === sn.id && !sn.pendingMerge;
        const isMerging = !!sn.pendingMerge;

        // trail
        if (sn.segments.length > 1) {
          ctx.strokeStyle = col.glow; ctx.lineWidth = SEG_R * 2 + 5;
          ctx.lineCap = "round"; ctx.lineJoin = "round";
          ctx.beginPath(); ctx.moveTo(sn.segments[0].x, sn.segments[0].y);
          for (let i = 1; i < sn.segments.length; i++) { const p = sn.segments[i - 1], c2 = sn.segments[i]; ctx.quadraticCurveTo(p.x, p.y, (p.x + c2.x) / 2, (p.y + c2.y) / 2); }
          ctx.stroke();

          for (let i = sn.segments.length - 1; i >= 1; i--) {
            const seg = sn.segments[i], t = 1 - i / sn.segments.length;
            // shedding: tail segments glow purple
            const tailPct = i / sn.segments.length;
            if (isShedding && tailPct > 0.6) {
              const shPulse = Math.sin(tick.current * 0.1 + i) * 0.3 + 0.7;
              ctx.globalAlpha = alpha * shPulse;
              ctx.fillStyle = "#dd88ff";
            } else {
              ctx.globalAlpha = alpha * (0.2 + 0.8 * t);
              ctx.fillStyle = col.body;
            }
            ctx.beginPath(); ctx.arc(seg.x, seg.y, SEG_R * (0.35 + 0.65 * t), 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = alpha;
        }

        // head
        const head = sn.segments[0];
        ctx.shadowColor = col.glow; ctx.shadowBlur = isSelected ? 26 : 14;
        ctx.fillStyle = col.head;
        ctx.beginPath(); ctx.arc(head.x, head.y, SEG_R + 2, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;

        // eyes
        const next = sn.segments[1] || head;
        const ea = Math.atan2(head.y - next.y, head.x - next.x);
        ctx.fillStyle = "#111";
        ctx.beginPath();
        ctx.arc(head.x + Math.cos(ea) * 3 + Math.cos(ea + 1.2) * 3, head.y + Math.sin(ea) * 3 + Math.sin(ea + 1.2) * 3, 1.6, 0, Math.PI * 2);
        ctx.arc(head.x + Math.cos(ea) * 3 + Math.cos(ea - 1.2) * 3, head.y + Math.sin(ea) * 3 + Math.sin(ea - 1.2) * 3, 1.6, 0, Math.PI * 2);
        ctx.fill();

        // label
        ctx.textAlign = "center";
        ctx.font = "bold 10px -apple-system, sans-serif"; ctx.fillStyle = col.head;
        const nameLabel = sn.task ? `${sn.name}: ${truncate(sn.task, 18)}` : sn.name;
        ctx.fillText(nameLabel, head.x, head.y - 18);
        // show parent link
        if (sn.parentId) {
          const parent = s.snakes.find(p => p.id === sn.parentId);
          if (parent) {
            ctx.font = "7px -apple-system, sans-serif"; ctx.fillStyle = "#335";
            ctx.fillText(`↑ ${parent.name}`, head.x, head.y - 47);
          }
        }
        // show child count
        const aliveKids = sn.childIds.filter(cid => { const c = s.snakes.find(sn => sn.id === cid); return c && c.alive; }).length;
        if (aliveKids > 0) {
          ctx.font = "7px -apple-system, sans-serif"; ctx.fillStyle = "#558";
          ctx.fillText(`↓ ${aliveKids} sub-agent${aliveKids > 1 ? "s" : ""}`, head.x, head.y - 47 + (sn.parentId ? -9 : 0));
        }
        ctx.font = "9px -apple-system, sans-serif"; ctx.fillStyle = "#445";
        const ctxLabel = isMerging
          ? (sn.pendingMerge.role === "survivor" ? "⊕ merging… (Esc cancel)" : "⊕ merging…")
          : sn._researchPhase
          ? `🔬 ${sn._researchPhase}`
          : sn._digestingFile
          ? `📄 digesting ${truncate(sn._digestingFile, 16)}…`
          : sn.isThinking
          ? "💭 thinking…"
          : (sn._errorCooldown && Date.now() < sn._errorCooldown)
          ? `⏸ cooldown ${Math.ceil((sn._errorCooldown - Date.now()) / 1000)}s`
          : sn.pendingThink
          ? "📖 reading…"
          : sn.scentTrail
          ? `🔍 "${truncate(sn.scentTrail.query, 14)}" (${sn.scentTrail.matchIds.length})`
          : !sn.autoSeek
          ? `standby · ctx:${sn.context.length}/${MAX_CONTEXT}`
          : sn.shedding ? "shedding…"
          : sn.task && sn.parentId ? `ctx:${sn.context.length} · cycle ${sn.thinkCount}/${SUBAGENT_MAX_THINKS}`
          : `ctx:${sn.context.length}/${MAX_CONTEXT}`;
        ctx.fillStyle = isMerging ? "#dd88ff" : sn._researchPhase ? "#5ce0d8" : sn._digestingFile ? "#cccc88" : sn.isThinking ? col.head : (sn._errorCooldown && Date.now() < sn._errorCooldown) ? "#ff666688" : sn.pendingThink ? col.head + "88" : sn.scentTrail ? col.head + "88" : "#445";
        ctx.fillText(ctxLabel, head.x, head.y - 28);
        // model badge if non-default
        if (sn.model && sn.model !== DEFAULT_MODEL) {
          ctx.font = "7px -apple-system, sans-serif";
          ctx.fillStyle = "#335";
          const shortModel = sn.model.replace(/^(claude-|gpt-)/, "").slice(0, 18);
          ctx.fillText(shortModel, head.x, head.y - 37);
        }
        ctx.textAlign = "left";

        if (isSelected) {
          ctx.strokeStyle = col.head + "44"; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.arc(head.x, head.y, 22 + Math.sin(tick.current * 0.06) * 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        }

        // merge-in-progress visuals
        if (isMerging && sn.pendingMerge.role === "survivor") {
          const partner = s.snakes.find(o => o.id === sn.pendingMerge.targetSnakeId);
          if (partner && partner.alive) {
            const ph = partner.segments[0];
            const midX = (head.x + ph.x) / 2, midY = (head.y + ph.y) / 2;
            const d = dist(head, ph);
            const progress = Math.max(0, 1 - d / 600); // 0 = far, 1 = touching

            // pulsing connecting line
            ctx.strokeStyle = `rgba(221,136,255,${0.15 + progress * 0.35})`;
            ctx.lineWidth = 1.5 + progress * 2;
            ctx.setLineDash([10, 6]);
            ctx.lineDashOffset = -tick.current * 0.6;
            ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(ph.x, ph.y); ctx.stroke();
            ctx.setLineDash([]); ctx.lineDashOffset = 0;

            // particles along the line as they get closer
            if (progress > 0.3) {
              const pCount = Math.floor(progress * 4);
              for (let p = 0; p < pCount; p++) {
                const t = ((tick.current * 0.005 + p * 0.25) % 1);
                const px = head.x + (ph.x - head.x) * t;
                const py = head.y + (ph.y - head.y) * t;
                ctx.globalAlpha = progress * 0.6 * Math.sin(t * Math.PI);
                ctx.fillStyle = "#dd88ff";
                ctx.beginPath(); ctx.arc(px, py, 2 + progress, 0, Math.PI * 2); ctx.fill();
              }
              ctx.globalAlpha = alpha;
            }

            // midpoint merge icon
            ctx.font = `${10 + progress * 6}px -apple-system, sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.globalAlpha = alpha * (0.3 + progress * 0.7);
            ctx.fillStyle = "#dd88ff";
            ctx.fillText("⊕", midX, midY);
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
            ctx.globalAlpha = alpha;
          }
        }

        // merge target hint
        if (isMergeTarget) {
          const mr = 24 + Math.sin(tick.current * 0.08) * 3;
          ctx.strokeStyle = "#dd88ff88"; ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]); ctx.lineDashOffset = -tick.current * 0.4;
          ctx.beginPath(); ctx.arc(head.x, head.y, mr, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]); ctx.lineDashOffset = 0;
          ctx.font = "bold 8px -apple-system, sans-serif";
          ctx.fillStyle = "#dd88ff";
          ctx.textAlign = "center";
          ctx.fillText("⊕ right-click to merge", head.x, head.y + mr + 12);
          ctx.textAlign = "left";
        }
        if (sn.leash) {
          const lz = sn.leash;
          const zg = ctx.createRadialGradient(lz.x, lz.y, 0, lz.x, lz.y, lz.radius);
          zg.addColorStop(0, col.head + "05"); zg.addColorStop(1, "transparent");
          ctx.fillStyle = zg; ctx.beginPath(); ctx.arc(lz.x, lz.y, lz.radius, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = col.head + "22"; ctx.lineWidth = 1; ctx.setLineDash([8, 6]); ctx.lineDashOffset = -tick.current * 0.3;
          ctx.beginPath(); ctx.arc(lz.x, lz.y, lz.radius, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
        if (sn.waypoint) {
          ctx.strokeStyle = col.head + "33"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(sn.waypoint.x, sn.waypoint.y); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
      }

      // particles
      for (const p of s.particles) { ctx.globalAlpha = p.life * 0.8; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.restore();

      /* ── MINIMAP ── */
      const mmW = 140, mmH = 100, mmX = W - mmW - 10, mmY = H - mmH - 10;
      ctx.fillStyle = "rgba(5,5,16,0.92)"; ctx.strokeStyle = "#0e0e30"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(mmX, mmY, mmW, mmH, 5); ctx.fill(); ctx.stroke();
      const mx = mmW / MAP_W, my = mmH / MAP_H;
      for (const b of s.bubbles) {
        const acColor = b.fileType ? b.fileType.color : (CATS[bubbleCat(b)] || CATS.default).color;
        ctx.fillStyle = acColor + "55";
        ctx.fillRect(mmX + b.x * mx - 1.5, mmY + b.y * my - 0.8, 3, 1.6);
      }
      for (const sn of s.snakes) {
        if (!sn.alive) continue;
        const col = PALETTES[sn.colorIdx % PALETTES.length];
        ctx.fillStyle = col.head;
        ctx.beginPath(); ctx.arc(mmX + sn.segments[0].x * mx, mmY + sn.segments[0].y * my, sn.id === s.selectedSnake ? 3.5 : 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.strokeRect(mmX + (s.camera.x - W / 2) * mx, mmY + (s.camera.y - H / 2) * my, W * mx, H * my);

      /* ── CAMERA MODE BADGE ── */
      if (s.cameraMode === "free") {
        ctx.fillStyle = "rgba(6,6,16,0.8)";
        ctx.strokeStyle = "#22224a";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(12, 12, 72, 20, 4); ctx.fill(); ctx.stroke();
        ctx.font = "9px -apple-system, sans-serif";
        ctx.fillStyle = "#666";
        ctx.fillText("🖱 Free cam", 20, 26);
      }

      /* Expanded bubble reading moved to React overlay for consistent markdown and source previews. */

      /* ── EXPANDED SNAKE CONTEXT CARD ── */
      if (s.expandedSnakeId) {
        const sn = s.snakes.find(sn => sn.id === s.expandedSnakeId);
        if (sn && sn.alive) {
          const col = PALETTES[sn.colorIdx % PALETTES.length];
          const head = sn.segments[0];
          const bsx = head.x - s.camera.x + W / 2;
          const bsy = head.y - s.camera.y + H / 2;

          const cardW = 360;
          const itemH = 28;
          const headerH = 40;
          const footerH = 24;
          const maxVisibleH = Math.min(H * 0.65, 450);
          const contentH = sn.context.length * itemH + 16;
          const cardH = Math.min(maxVisibleH, headerH + contentH + footerH);
          const scrollMax = Math.max(0, contentH - (cardH - headerH - footerH));
          s.expandedScroll = clamp(s.expandedScroll || 0, 0, scrollMax);

          let cx = clamp(bsx - cardW / 2, 8, W - cardW - 8);
          let cy = clamp(bsy - cardH / 2, 8, H - cardH - 8);

          // dim
          ctx.fillStyle = "rgba(0,0,0,0.4)";
          ctx.fillRect(0, 0, W, H);

          // card
          ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 8;
          ctx.fillStyle = "#0a0a16"; ctx.strokeStyle = col.body + "44"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect(cx, cy, cardW, cardH, 10); ctx.fill(); ctx.stroke();
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

          // header
          ctx.fillStyle = col.body + "14";
          ctx.beginPath(); ctx.roundRect(cx, cy, cardW, headerH, [10, 10, 0, 0]); ctx.fill();
          ctx.fillStyle = col.head;
          ctx.font = "bold 12px -apple-system, sans-serif";
          ctx.fillText(`🐍 ${sn.name}${sn.task ? ": " + truncate(sn.task, 22) : ""}`, cx + 14, cy + 18);
          ctx.font = "9px -apple-system, sans-serif";
          ctx.fillStyle = "#556";
          ctx.fillText(`${sn.context.length} items · ${sn.model.replace(/^(claude-|gpt-)/, "").slice(0, 20)}${sn._digestingFile ? " · 📄 digesting…" : sn.isThinking ? " · 💭 thinking…" : sn.pendingThink ? " · reading…" : sn.shedding ? " · shedding…" : ""}`, cx + 14, cy + 32);

          // close hint
          ctx.textAlign = "right"; ctx.fillStyle = "#334"; ctx.font = "9px -apple-system, sans-serif";
          ctx.fillText("click away to close", cx + cardW - 12, cy + 32);
          ctx.textAlign = "left";

          // clipped content
          const contentY = cy + headerH;
          const contentVisH = cardH - headerH - footerH;
          ctx.save();
          ctx.beginPath(); ctx.rect(cx, contentY, cardW, contentVisH); ctx.clip();

          const scrollOff = s.expandedScroll || 0;
          if (sn.context.length === 0) {
            ctx.font = "11px -apple-system, sans-serif"; ctx.fillStyle = "#334";
            ctx.fillText("Empty — snake hasn't read anything yet", cx + 14, contentY + 24);
          }
          sn.context.forEach((item, i) => {
            const iy = contentY + 8 + i * itemH - scrollOff;
            if (iy < contentY - itemH || iy > contentY + contentVisH) return;
            const cat = CATS[item.category] || CATS.default;

            // row bg on hover
            ctx.fillStyle = i % 2 === 0 ? "#0c0c18" : "#0a0a14";
            ctx.fillRect(cx + 4, iy, cardW - 8, itemH - 2);

            // role dot
            ctx.fillStyle = item.role === "user" ? "#22d65b" : item.role === "assistant" ? "#5bc0eb" : "#888";
            ctx.beginPath(); ctx.arc(cx + 16, iy + itemH / 2 - 1, 3, 0, Math.PI * 2); ctx.fill();

            // category tag
            ctx.font = "bold 8px -apple-system, sans-serif";
            ctx.fillStyle = cat.color + "88";
            ctx.fillText(cat.icon, cx + 28, iy + itemH / 2 + 2);

            // summary
            ctx.font = "600 10px -apple-system, sans-serif";
            ctx.fillStyle = "#99a";
            ctx.fillText(truncate(item.summary || item.content?.slice(0, 40) || "…", 32), cx + 42, iy + itemH / 2 - 3);

            // preview of content
            ctx.font = "9px -apple-system, sans-serif";
            ctx.fillStyle = "#445";
            ctx.fillText(truncate(item.content || "", 42), cx + 42, iy + itemH / 2 + 10);
          });

          ctx.restore();

          // scrollbar
          if (scrollMax > 0) {
            const trackH = contentVisH - 8;
            const thumbH = Math.max(20, trackH * (contentVisH / contentH));
            const thumbY = contentY + 4 + (trackH - thumbH) * (scrollOff / scrollMax);
            ctx.fillStyle = col.body + "22";
            ctx.beginPath(); ctx.roundRect(cx + cardW - 6, contentY + 4, 3, trackH, 1.5); ctx.fill();
            ctx.fillStyle = col.body + "55";
            ctx.beginPath(); ctx.roundRect(cx + cardW - 6, thumbY, 3, thumbH, 1.5); ctx.fill();
          }

          // footer
          const ftY = cy + cardH - footerH;
          ctx.fillStyle = "#0c0c1a";
          ctx.beginPath(); ctx.roundRect(cx, ftY, cardW, footerH, [0, 0, 10, 10]); ctx.fill();
          ctx.font = "9px -apple-system, sans-serif"; ctx.fillStyle = "#334";
          const ctxSize = sn.context.reduce((s, c) => s + (c.content?.length || 0), 0);
          ctx.fillText(`${sn.context.length}/${MAX_CONTEXT} items · ~${(ctxSize / 1000).toFixed(1)}k chars`, cx + 14, ftY + 16);
          if (scrollMax > 0) {
            ctx.textAlign = "right"; ctx.fillText("scroll for more", cx + cardW - 12, ftY + 16); ctx.textAlign = "left";
          }
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ── AUTONOMOUS THINK — snakes auto-call API after reading on their own ── */
  useEffect(() => {
    const THINK_DELAY = 3000; // ms to wait after last read before thinking
    const iv = setInterval(async () => {
      const s = S.current;
      const now = Date.now();
      // only one snake thinks at a time to avoid rate limits
      const anyThinking = s.snakes.some(sn => sn.isThinking);
      if (anyThinking) return;
      for (const sn of s.snakes) {
        if (!sn.alive || !sn.pendingThink || sn.isThinking || sn.pendingMerge) continue;
        if (sn._researchPhase) continue; // controlled by runResearch
        if (s.pendingDigests.some(d => d.snakeId === sn.id) || sn._digestingFile) continue;
        if (now - sn.pendingThink < THINK_DELAY) continue;
        // error cooldown — don't retry until cooldown expires
        if (sn._errorCooldown && now < sn._errorCooldown) continue;

        // sub-agent lifecycle: force complete if hit think limit
        if (sn.task && sn.parentId && sn.thinkCount >= SUBAGENT_MAX_THINKS) {
          const parent = s.snakes.find(p => p.id === sn.parentId && p.alive);
          if (parent) {
            const summary = `Auto-completed after ${sn.thinkCount} cycles. Last context: ${sn.context.slice(-2).map(c => c.summary || c.content?.slice(0, 40)).join("; ")}`;
            const pos = placeBubble(summary, s.bubbles, sn.segments[0].x, sn.segments[0].y);
            s.bubbles.push(makeBubble(summary, `${sn.name}: auto-done`, "analysis", "assistant", pos.x, pos.y));
            sn.pendingMerge = { targetSnakeId: parent.id, role: "absorbed" };
            parent.pendingMerge = { targetSnakeId: sn.id, role: "survivor" };
            sn.waypoint = null; sn.leash = null; sn.scentTrail = null; sn.pendingThink = 0;
            s.notifications.push({ id: uid(), text: `${sn.name} auto-completed (${SUBAGENT_MAX_THINKS} cycles) — merging back`, bubbleId: null, snakeColorIdx: sn.colorIdx, createdAt: Date.now() });
            console.log("auto-complete:", sn.name, "after", sn.thinkCount, "thinks");
          }
          rerender(n => n + 1);
          continue;
        }

        // time to think
        sn.pendingThink = 0;
        sn.isThinking = true;
        sn.thinkCount++;
        sn.lastActivityTime = Date.now();
        rerender(n => n + 1);

        const head = sn.segments[0];
        const rawCtx = sn.context.map(c => ({ role: c.role, content: c.content }));
        const fileList = s.bubbles.filter(b => b.fileName).map(b => b.fileName).join(", ");
        if (fileList) rawCtx.push({ role: "user", content: `[Available files on map: ${fileList}]` });

        // build hierarchy + lifecycle context
        const aliveChildren = sn.childIds.map(cid => s.snakes.find(c => c.id === cid)).filter(c => c && c.alive);
        const deadChildren = sn.childIds.map(cid => s.snakes.find(c => c.id === cid)).filter(c => c && !c.alive);
        let hierInfo = "";
        if (aliveChildren.length > 0) hierInfo += `\nYour active sub-agents: ${aliveChildren.map(c => `${c.name} (task: ${c.task || "general"})`).join(", ")}. Wait for them or continue.`;
        if (deadChildren.length > 0) hierInfo += `\n${deadChildren.length} sub-agent(s) completed and merged back.`;
        if (sn.task && sn.parentId) {
          const remaining = SUBAGENT_MAX_THINKS - sn.thinkCount;
          hierInfo += `\nYou are a sub-agent (depth ${sn.depth}). ${remaining} think cycles remaining. Call complete_task(summary) when done — you MUST finish before running out.`;
          if (remaining <= 2) hierInfo += ` ⚠️ ALMOST OUT OF CYCLES — wrap up and call complete_task NOW.`;
        }
        const canSpawn = s.snakes.filter(sn => sn.alive).length < MAX_ALIVE_SNAKES && (sn.depth || 0) < MAX_SPAWN_DEPTH;
        if (!canSpawn) hierInfo += `\nYou cannot spawn more sub-agents (limit reached).`;

        const taskPrompt = sn.task && sn.parentId
          ? (sn.thinkCount <= 1
            ? `Your research task: "${sn.task}". Do 2-3 web_search calls NOW to gather evidence.${hierInfo}`
            : `Task: "${sn.task}". Cycle ${sn.thinkCount}/${SUBAGENT_MAX_THINKS}. You should have search results by now. Call complete_task(summary) with your key findings immediately.${hierInfo}`)
          : sn.task
          ? `Research topic: "${sn.task}". Cycle ${sn.thinkCount}. Plan sub-topics and spawn_agent for each. Search for overview first.${hierInfo}`
          : (() => {
            const hasChildren = sn.childIds.some(cid => s.snakes.find(c => c.id === cid && c.alive));
            const mergedChildren = sn.childIds.filter(cid => { const c = s.snakes.find(sn => sn.id === cid); return c && !c.alive; }).length;
            if (hasChildren) return `Waiting for sub-agents to complete. Review any merged context and prepare to synthesize.${hierInfo}`;
            if (mergedChildren > 0 && sn.context.length > 3) return `Your sub-agents have completed and merged back. You now have their findings in your context. Call produce_result with a comprehensive markdown report synthesizing everything. Include source links.${hierInfo}`;
            return `Analyze your context and decide: search the web, spawn sub-agents for sub-topics, or produce_result if you have enough.${hierInfo}`;
          })();
        rawCtx.push({ role: "user", content: taskPrompt });
        const ctxMsgs = trimContext(rawCtx);

        const result = await getAIResponse(ctxMsgs, { model: sn.model, apiKey: sn.apiKey, apiBase: sn.apiBase });

        // detect error — don't create bubbles, just notify and cooldown
        const isError = result.segments?.length === 1 && result.segments[0].category === "error";
        if (isError) {
          sn.isThinking = false;
          sn.pendingThink = 0;
          sn._errorCooldown = Date.now() + 15000; // 15s cooldown
          const errMsg = result.segments[0].summary || "API error";
          // only notify, don't create a bubble
          s.notifications.push({
            id: uid(), text: `${sn.name}: ${errMsg} — pausing 15s`,
            bubbleId: null, snakeColorIdx: sn.colorIdx, createdAt: Date.now(),
          });
          console.warn("auto-think error, cooling down:", sn.name, errMsg);
          rerender(n => n + 1);
          continue;
        }

        for (const seg of (result.segments || [])) {
          const anchor = s.bubbles[s.bubbles.length - 1] || { x: head.x, y: head.y };
          const p = placeBubble(seg.text, s.bubbles, anchor.x, anchor.y);
          s.bubbles.push(makeBubble(seg.text, seg.summary || "Thought", seg.category || "analysis", "assistant", p.x, p.y));
        }

        // notify human
        const segCount = (result.segments || []).length;
        if (segCount > 0) {
          const firstSummary = result.segments[0].summary || "New output";
          const lastBubble = s.bubbles[s.bubbles.length - 1];
          s.notifications.push({
            id: uid(), text: `${sn.name}: ${firstSummary}${segCount > 1 ? ` +${segCount - 1} more` : ""}`,
            bubbleId: lastBubble?.id, snakeColorIdx: sn.colorIdx, createdAt: Date.now(),
          });
        }

        if (result.tool_calls?.length) await executeToolCalls(result.tool_calls, sn, S, tick, spawnP, rerender);

        sn.isThinking = false;
        rerender(n => n + 1);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  /* ── FILE DIGEST PROCESSOR — analyze files into compact context ── */
  useEffect(() => {
    let processing = false;
    const iv = setInterval(async () => {
      const s = S.current;
      if (processing || s.pendingDigests.length === 0) return;
      processing = true;

      // process one digest at a time
      const digest = s.pendingDigests.shift();
      const snake = s.snakes.find(sn => sn.id === digest.snakeId);
      if (!snake || !snake.alive) { processing = false; return; }

      const col = PALETTES[snake.colorIdx % PALETTES.length];

      // show digesting status
      snake._digestingFile = digest.fileName;
      rerender(n => n + 1);

      const result = await digestFile(digest.fileName, digest.content, {
        model: snake.model, apiKey: snake.apiKey, apiBase: snake.apiBase,
      });

      // store the compact analysis, not the raw file
      snake.context.push({
        role: "user",
        content: `[File: ${digest.fileName}] ${result.analysis}`,
        summary: result.summary || digest.fileName,
        category: "analysis",
      });

      snake._digestingFile = null;

      // if autonomous, schedule thinking
      if (digest.isAutonomous && !snake.isThinking) {
        snake.pendingThink = Date.now();
      }

      processing = false;
      rerender(n => n + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  /* ── SUB-AGENT IDLE TIMEOUT — auto-complete stale sub-agents ── */
  useEffect(() => {
    const iv = setInterval(() => {
      const s = S.current;
      const now = Date.now();
      for (const sn of s.snakes) {
        if (!sn.alive || !sn.task || !sn.parentId) continue; // only sub-agents
        if (sn.isThinking || sn.pendingMerge || sn._digestingFile) continue; // busy
        if (s.pendingDigests.some(d => d.snakeId === sn.id)) continue; // digesting
        if (sn.pendingThink) continue; // about to think
        // check idle timeout
        if (now - sn.lastActivityTime > SUBAGENT_IDLE_TIMEOUT) {
          const parent = s.snakes.find(p => p.id === sn.parentId && p.alive);
          if (parent) {
            const summary = `Idle timeout after ${sn.thinkCount} cycles. Context: ${sn.context.slice(-2).map(c => c.summary || "").filter(Boolean).join("; ") || "none"}`;
            const pos = placeBubble(summary, s.bubbles, sn.segments[0].x, sn.segments[0].y);
            s.bubbles.push(makeBubble(summary, `${sn.name}: timed out`, "analysis", "assistant", pos.x, pos.y));
            sn.pendingMerge = { targetSnakeId: parent.id, role: "absorbed" };
            parent.pendingMerge = { targetSnakeId: sn.id, role: "survivor" };
            sn.waypoint = null; sn.leash = null; sn.scentTrail = null;
            s.notifications.push({ id: uid(), text: `${sn.name} timed out — merging back to ${parent.name}`, bubbleId: null, snakeColorIdx: sn.colorIdx, createdAt: Date.now() });
            console.log("idle timeout:", sn.name);
            rerender(n => n + 1);
          }
        }
      }
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  /* ── send message — starts research or steers mid-research ── */
  const sendMessage = useCallback(async () => {
    if (!input.trim()) return;
    const s = S.current;
    const active = getSelectedSnake(s);
    if (!active) {
      s.notifications.push({
        id: uid(),
        text: "Select a snake first — draft kept in the box",
        bubbleId: null,
        snakeColorIdx: 0,
        createdAt: Date.now(),
      });
      rerender(n => n + 1);
      return;
    }
    if (REQUIRE_PERSONAL_API_KEY && !hasPersonalApiKey(active)) {
      setConfigOpen(active.id);
      s.notifications.push({
        id: uid(),
        text: getMissingKeyMessage(active),
        bubbleId: null,
        snakeColorIdx: active.colorIdx,
        createdAt: Date.now(),
      });
      rerender(n => n + 1);
      return;
    }
    const text = input.trim();
    setInput("");
    inputRef.current?.focus();
    const head = active.segments[0];

    // Mid-research steering — add note instead of starting new research
    if (active._researchPhase) {
      active._steeringNotes.push(text);
      // Create a small steering bubble near the snake
      const pos = placeBubble(text, s.bubbles, head.x + 30, head.y - 30);
      s.bubbles.push(makeBubble(text, `🧭 ${truncate(text, 18)}`, "idea", "user", pos.x, pos.y));
      s.notifications.push({
        id: uid(), text: `Steering note added — will apply at next reflection`,
        bubbleId: null, snakeColorIdx: active.colorIdx, createdAt: Date.now(),
      });
      rerender(n => n + 1);
      return;
    }

    if (loading) return;

    // Create user question bubble
    const pos = placeBubble(text, s.bubbles, head.x, head.y);
    const ub = makeBubble(text, truncate(text, 24), classifyUser(text), "user", pos.x, pos.y);
    s.bubbles.push(ub);
    active.autoSeek = true;
    active.waypoint = { x: ub.x, y: ub.y };
    active.task = text;
    active._steeringNotes = [];
    active._humanPins = [];

    setLoading(true); rerender(n => n + 1);

    try {
      await runResearch(text, active, S, spawnP, rerender);
    } catch (e) {
      console.error("research error:", e);
      s.notifications.push({
        id: uid(), text: `Research error: ${e.message?.slice(0, 50)}`,
        bubbleId: null, snakeColorIdx: active.colorIdx, createdAt: Date.now(),
      });
    }

    active.task = null;
    active.autoSeek = false;
    active._researchPhase = null;
    active._steeringNotes = [];
    active._humanPins = [];
    setLoading(false); rerender(n => n + 1);
  }, [input, loading]);

  /* ── SMART MERGE ── */
  async function performSmartMerge(survivor, absorbed) {
    const s = S.current;
    const absHead = absorbed.segments[0];
    const surHead = survivor.segments[0];
    const col = PALETTES[absorbed.colorIdx % PALETTES.length];

    // mark as merging
    absorbed.alive = false;
    absorbed.mergeAnim = 1.0;
    spawnP(absHead.x, absHead.y, col.body, 20);

    // transfer children to survivor
    for (const childId of absorbed.childIds) {
      const child = s.snakes.find(sn => sn.id === childId);
      if (child) child.parentId = survivor.id;
      if (!survivor.childIds.includes(childId)) survivor.childIds.push(childId);
    }
    // remove absorbed from survivor's children list
    survivor.childIds = survivor.childIds.filter(id => id !== absorbed.id);

    // deduplicate: find context items in absorbed that aren't in survivor
    const survivorTexts = new Set(survivor.context.map(c => c.content));
    const uniqueItems = absorbed.context.filter(c => !survivorTexts.has(c.content));

    if (uniqueItems.length === 0) {
      // nothing new to add
      s.selectedSnake = survivor.id;
      s.notifications.push({
        id: uid(), text: `Merged ${absorbed.name} → ${survivor.name} (no new context)`,
        bubbleId: null, snakeColorIdx: survivor.colorIdx, createdAt: Date.now(),
      });
      rerender(n => n + 1);
      return;
    }

    // compress unique items via LLM
    const result = await compressContext(uniqueItems, { model: survivor.model, apiKey: survivor.apiKey, apiBase: survivor.apiBase });

    // inject compressed summary as one context item
    survivor.context.push({
      role: "system", content: result.text,
      summary: `Merged from ${absorbed.name}: ${result.summary}`,
      category: "memory",
    });

    // spawn a memory bubble at the merge point
    const midX = (surHead.x + absHead.x) / 2;
    const midY = (surHead.y + absHead.y) / 2;
    const pos = placeBubble(result.text, s.bubbles, midX, midY);
    const mb = makeBubble(result.text, `Merge: ${absorbed.name} → ${survivor.name}`, "memory", "system", pos.x, pos.y, { isMemory: true });
    mb.compressedFrom = uniqueItems.length;
    mb.readers.push(survivor.id);
    mb.humanRead = false;
    s.bubbles.push(mb);

    s.selectedSnake = survivor.id;
    spawnP(pos.x, pos.y, "#dd88ff", 12);

    s.notifications.push({
      id: uid(), text: `Merged ${absorbed.name} → ${survivor.name} (${uniqueItems.length} unique items compressed)`,
      bubbleId: mb.id, snakeColorIdx: survivor.colorIdx, createdAt: Date.now(),
    });

    rerender(n => n + 1);
  }

  const forkActive = useCallback(() => {
    const s = S.current;
    const active = s.snakes.find(sn => sn.id === s.selectedSnake && sn.alive) || s.snakes.find(sn => sn.alive);
    if (!active) return;
    const ci = s.nextColor++;
    const ns = makeSnake(active.segments[0].x + 25, active.segments[0].y + 25, ci, [...active.context], null, {
      model: active.model, apiKey: active.apiKey, apiBase: active.apiBase, autoSeek: false,
      parentId: active.id, depth: (active.depth || 0) + 1,
    });
    ns.spawnAnim = 1.0;
    active.childIds.push(ns.id);
    s.snakes.push(ns); s.selectedSnake = ns.id;
    spawnP(active.segments[0].x, active.segments[0].y, PALETTES[ci % PALETTES.length].body, 14);
    rerender(n => n + 1);
  }, []);

  const mergeActive = useCallback(() => {
    const s = S.current;
    const sel = s.snakes.find(sn => sn.id === s.selectedSnake && sn.alive);
    const biggest = s.snakes.filter(sn => sn.alive && sn.id !== sel?.id).sort((a, b) => b.context.length - a.context.length)[0];
    if (sel && biggest) {
      const survivor = sel.context.length >= biggest.context.length ? sel : biggest;
      const absorbed = survivor === sel ? biggest : sel;
      survivor.pendingMerge = { targetSnakeId: absorbed.id, role: "survivor" };
      absorbed.pendingMerge = { targetSnakeId: survivor.id, role: "absorbed" };
      survivor.waypoint = null; survivor.leash = null; survivor.scentTrail = null;
      absorbed.waypoint = null; absorbed.leash = null; absorbed.scentTrail = null;
      s.notifications.push({
        id: uid(), text: `Merging ${absorbed.name} → ${survivor.name}… (Esc to cancel)`,
        bubbleId: null, snakeColorIdx: survivor.colorIdx, createdAt: Date.now(),
      });
      rerender(n => n + 1);
    }
  }, []);

  const deleteSelected = useCallback(() => {
    const s = S.current;
    const trashed = s.bubbles.filter(b => s.selectedBubbles.has(b.id));
    s.trash.push(...trashed);
    s.bubbles = s.bubbles.filter(b => !s.selectedBubbles.has(b.id));
    s.selectedBubbles.clear();
    rerender(n => n + 1);
  }, []);

  const restoreFromTrash = useCallback((id) => {
    const s = S.current;
    const idx = s.trash.findIndex(b => b.id === id);
    if (idx !== -1) {
      const b = s.trash.splice(idx, 1)[0];
      s.bubbles.push(b);
    }
    rerender(n => n + 1);
  }, []);

  const emptyTrash = useCallback(() => {
    S.current.trash = [];
    rerender(n => n + 1);
  }, []);

  const ctxCopy = useCallback((bubbleId) => {
    const s = S.current;
    const orig = s.bubbles.find(b => b.id === bubbleId);
    if (!orig) { setCtxMenu(null); return; }
    const pos = placeBubble(orig.items[0].text, s.bubbles, orig.x + 60, orig.y + 30);
    const copy = makeBubble(
      orig.items[0].text,
      orig.items[0].summary,
      orig.items[0].category,
      orig.items[0].role,
      pos.x, pos.y,
      {
        autoSeekable: orig.autoSeekable,
        fileName: orig.fileName,
        fileSize: orig.fileSize,
        fileType: orig.fileType,
        isMemory: orig.isMemory,
      }
    );
    // copy additional items if merged bubble
    if (orig.items.length > 1) {
      for (let i = 1; i < orig.items.length; i++) copy.items.push({ ...orig.items[i] });
    }
    if (orig.imageDataUrl) {
      copy.imageDataUrl = orig.imageDataUrl;
      const img = new Image(); img.src = orig.imageDataUrl;
      s.imageCache[copy.id] = img;
    }
    s.bubbles.push(copy);
    const cat = CATS[bubbleCat(orig)] || CATS.default;
    spawnP(pos.x, pos.y, orig.fileType ? orig.fileType.color : cat.color, 6);
    setCtxMenu(null);
    rerender(n => n + 1);
  }, []);

  const ctxDelete = useCallback((bubbleId) => {
    const s = S.current;
    const b = s.bubbles.find(b => b.id === bubbleId);
    if (b) { s.trash.push(b); s.bubbles = s.bubbles.filter(b => b.id !== bubbleId); }
    s.selectedBubbles.delete(bubbleId);
    setCtxMenu(null);
    rerender(n => n + 1);
  }, []);

  const spawnFreshAgent = useCallback((seedSnake = null) => {
    const s = S.current;
    const base = seedSnake && seedSnake.alive ? seedSnake : getPrimarySnake(s);
    if (!base) return;
    const ci = s.nextColor++;
    const ns = makeSnake(base.segments[0].x + 34, base.segments[0].y + 34, ci, [], null, {
      model: base.model,
      apiKey: base.apiKey,
      apiBase: base.apiBase,
      depth: 0,
      autoSeek: false,
    });
    ns.spawnAnim = 1.0;
    ns.lastActivityTime = Date.now();
    s.snakes.push(ns);
    s.selectedSnake = ns.id;
    s.cameraMode = "follow";
    persistSnakeConfig(ns);
    spawnP(base.segments[0].x, base.segments[0].y, PALETTES[ci % PALETTES.length].body, 14);
    s.notifications.push({
      id: uid(),
      text: `${ns.name}: fresh agent ready`,
      bubbleId: null,
      snakeColorIdx: ns.colorIdx,
      createdAt: Date.now(),
    });
    rerender(n => n + 1);
  }, []);

  const clearSnakeContext = useCallback((targetSnake = null) => {
    const s = S.current;
    const snake = targetSnake && targetSnake.alive ? targetSnake : getPrimarySnake(s);
    if (!snake) return;
    const busyReason = getSnakeBusyReason(s, snake);
    if (busyReason) {
      s.notifications.push({
        id: uid(),
        text: `${snake.name}: finish ${busyReason} before clearing context`,
        bubbleId: null,
        snakeColorIdx: snake.colorIdx,
        createdAt: Date.now(),
      });
      rerender(n => n + 1);
      return;
    }
    const clearedCount = snake.context.length;
    snake.context = [];
    snake.autoSeek = false;
    snake.task = null;
    snake.pendingThink = 0;
    snake.isThinking = false;
    snake._researchPhase = null;
    snake._researchIteration = null;
    snake._steeringNotes = [];
    snake._humanPins = [];
    snake._digestingFile = null;
    snake.targetBubble = null;
    snake.waypoint = null;
    snake.leash = null;
    snake.scentTrail = null;
    snake.lastActivityTime = Date.now();
    s.selectedSnake = snake.id;
    spawnP(snake.segments[0].x, snake.segments[0].y, PALETTES[snake.colorIdx % PALETTES.length].head, 12);
    s.notifications.push({
      id: uid(),
      text: `${snake.name}: cleared ${clearedCount} context item${clearedCount === 1 ? "" : "s"}`,
      bubbleId: null,
      snakeColorIdx: snake.colorIdx,
      createdAt: Date.now(),
    });
    rerender(n => n + 1);
  }, []);

  const activeSnake = getPrimarySnake(S.current);
  const activeSnakeBusyReason = getSnakeBusyReason(S.current, activeSnake);
  const canClearActiveSnake = !!activeSnake && !activeSnakeBusyReason && activeSnake.context.length > 0;
  const autosaveLabel = lastPersistedAt
    ? `Auto-saved ${new Date(lastPersistedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "Auto-saves locally";
  const currentSessionLabel = isPlaceholderSessionName(mapName) && !hasSessionContent()
    ? "New session"
    : mapName;

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#050510", display: "flex", flexDirection: "column", fontFamily: "-apple-system, 'Segoe UI', sans-serif", overflow: "hidden" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 14px", background: "#080812", borderBottom: "1px solid #10102a", zIndex: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#22d65b", fontSize: 14, fontWeight: 700, letterSpacing: 1.5, fontFamily: "'SF Mono','Fira Code',monospace" }}>🐍 CONTEXT·SNAKE</span>
          <span style={{ color: "#222240", fontSize: 9.5 }}>
            Double-click 🔗 to open · Click ★ to read · Click bubble mid-research to pin · Type to steer
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => { S.current.cameraMode = S.current.cameraMode === "follow" ? "free" : "follow"; rerender(n => n + 1); }} style={{
            background: S.current.cameraMode === "follow" ? "#22d65b18" : "transparent",
            color: S.current.cameraMode === "follow" ? "#22d65b" : "#666",
            border: `1px solid ${S.current.cameraMode === "follow" ? "#22d65b44" : "#22224433"}`,
            borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
          }}>{S.current.cameraMode === "follow" ? "📷 Following" : "🖱 Free cam"}</button>
          <button onClick={forkActive} style={{ background: "transparent", color: "#22d65b", border: "1px solid #22d65b33", borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>+ Fork</button>
          <button
            onClick={() => spawnFreshAgent()}
            style={{ background: "transparent", color: "#80ffdb", border: "1px solid #80ffdb33", borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}
          >+ Fresh</button>
          <button
            onClick={() => clearSnakeContext()}
            disabled={!canClearActiveSnake}
            title={activeSnakeBusyReason ? `Finish ${activeSnakeBusyReason} before clearing context` : activeSnake?.context.length ? "Clear this agent's internal memory" : "Agent is already clean"}
            style={{ background: "transparent", color: canClearActiveSnake ? "#ffb86b" : "#445", border: `1px solid ${canClearActiveSnake ? "#ffb86b33" : "#22224433"}`, borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: canClearActiveSnake ? "pointer" : "not-allowed", fontFamily: "inherit", opacity: canClearActiveSnake ? 1 : 0.55 }}
          >Clear ctx</button>
          <button onClick={mergeActive} style={{ background: "transparent", color: "#e6a020", border: "1px solid #e6a02033", borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>⊕ Merge</button>
          {S.current.selectedBubbles.size > 0 && (
            <button onClick={deleteSelected} style={{ background: "transparent", color: "#ff6666", border: "1px solid #ff666633", borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>Delete ({S.current.selectedBubbles.size})</button>
          )}
          <div style={{ width: 1, height: 16, background: "#1a1a30", margin: "0 2px" }} />
          <button onClick={() => setTrashOpen(p => !p)} style={{
            background: trashOpen ? "#1a1030" : "transparent", color: trashOpen ? "#cc88ff" : "#555",
            border: `1px solid ${trashOpen ? "#44226666" : "#22224433"}`,
            borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit",
          }}>🗑{S.current.trash.length > 0 ? ` ${S.current.trash.length}` : ""}</button>
          <div style={{ width: 1, height: 16, background: "#1a1a30", margin: "0 2px" }} />
          <div style={{ color: lastPersistedAt ? "#6b82a6" : "#445", fontSize: 10, padding: "0 4px", whiteSpace: "nowrap" }}>{autosaveLabel}</div>
          <button onClick={() => setMapMenuOpen(p => !p)} style={{ background: mapMenuOpen ? "#101028" : "transparent", color: mapMenuOpen ? "#66aaff" : "#555", border: `1px solid ${mapMenuOpen ? "#336699" : "#22224433"}`, borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>☰ {currentSessionLabel}</button>
          <button onClick={() => setLogOpen(p => !p)} style={{ background: logOpen ? "#101820" : "transparent", color: logOpen ? "#5ce0d8" : "#555", border: `1px solid ${logOpen ? "#186660" : "#22224433"}`, borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>📋 Log</button>
          <button onClick={() => setDebugOpen(p => !p)} style={{ background: debugOpen ? "#1a1014" : "transparent", color: debugOpen ? "#ff8844" : "#555", border: `1px solid ${debugOpen ? "#663322" : "#22224433"}`, borderRadius: 5, padding: "3px 9px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>🐛 Debug</button>
          {loading && <span style={{ color: "#22d65b", fontSize: 10 }}><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>◌</span> working…</span>}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <div style={{ width: "100%", height: "100%" }}><canvas ref={canvasRef} style={{ display: "block" }} /></div>

          {/* Notifications */}
          {(() => {
            const s = S.current;
            const now = Date.now();
            // clean old notifications
            s.notifications = s.notifications.filter(n => now - n.createdAt < 8000);
            return s.notifications.map((notif, i) => {
              const age = (now - notif.createdAt) / 1000;
              const opacity = age > 6 ? Math.max(0, 1 - (age - 6) / 2) : Math.min(1, age / 0.3);
              const col = PALETTES[notif.snakeColorIdx % PALETTES.length];
              return (
                <div key={notif.id}
                  onClick={() => {
                    const b = s.bubbles.find(b => b.id === notif.bubbleId);
                    if (b) { s.camera.x = b.x; s.camera.y = b.y; s.cameraMode = "free"; }
                    s.notifications = s.notifications.filter(n => n.id !== notif.id);
                    rerender(n => n + 1);
                  }}
                  style={{
                    position: "absolute", top: 10 + i * 38, right: 10, zIndex: 12,
                    background: "#0c0c1aee", border: `1px solid ${col.body}44`,
                    borderRadius: 8, padding: "7px 14px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                    opacity, transition: "opacity 0.3s", maxWidth: 300,
                    boxShadow: `0 4px 20px rgba(0,0,0,0.5), inset 0 0 0 1px ${col.body}11`,
                  }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: col.head, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "#b0b0c4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{notif.text}</span>
                </div>
              );
            });
          })()}

          {S.current.previewBubbleId && (() => {
            const s = S.current;
            const b = s.bubbles.find(bubble => bubble.id === s.previewBubbleId);
            if (!b) return null;

            const catKey = bubbleCat(b);
            const cat = CATS[catKey] || CATS.default;
            const accentColor = b.fileType ? b.fileType.color : cat.color;
            const sourceDisplay = b.sourceUrl ? getSourceDisplayData(b) : null;
            const previewText = getBubblePreviewText(b, b.isResult ? 760 : b.sourceUrl ? 620 : 560);
            const previewLead = extractMarkdownLead(previewText, b.isResult ? 260 : 220);
            const previewOutline = b.isResult ? extractMarkdownOutline(previewText, 6) : [];
            const insightBullets = !b.isResult && !b.sourceUrl ? extractInsightBullets(previewText, 3, 148) : [];

            const title = b.isResult
              ? (b.resultTitle || "Research Report")
              : sourceDisplay?.title || bubbleSummary(b);
            const icon = b.isResult
              ? "★"
              : sourceDisplay?.icon || (b.fileType ? b.fileType.icon : cat.icon);
            const badge = b.fileType
              ? b.fileType.label
              : b.isResult
              ? "Research Report"
              : sourceDisplay?.kindLabel || catKey.charAt(0).toUpperCase() + catKey.slice(1);
            const meta = b.sourceUrl
              ? `${sourceDisplay?.siteName || sourceDisplay?.hostLabel || "External source"} · ${sourceDisplay?.kindLabel || "Source"}`
              : b.isResult
              ? `${b.resultSources?.length || 0} source${(b.resultSources?.length || 0) === 1 ? "" : "s"}`
              : `${bubbleLen(b)} chars`;
            const actionHint = b.isResult
              ? "Click to open full report"
              : b.sourceUrl
              ? "Double-click to open source"
              : "Double-click to inspect";

            const cW = canvasRef.current?.parentElement?.clientWidth || 800;
            const cH = canvasRef.current?.parentElement?.clientHeight || 600;
            const previewW = Math.min(b.isResult ? 460 : b.sourceUrl ? 430 : 390, cW - 24);
            const previewMaxH = Math.min(b.isResult ? 420 : b.sourceUrl ? 440 : 360, cH - 24);
            const anchorX = b.x - s.camera.x + cW / 2;
            const anchorY = b.y - s.camera.y + cH / 2;
            let px = anchorX + 38;
            if (px + previewW > cW - 12) px = anchorX - previewW - 38;
            px = clamp(px, 12, cW - previewW - 12);
            const py = clamp(anchorY - previewMaxH * 0.38, 12, cH - previewMaxH - 12);

            return (
              <div
                style={{
                  position: "absolute",
                  left: px,
                  top: py,
                  width: previewW,
                  zIndex: 14,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    maxHeight: previewMaxH,
                    display: "flex",
                    flexDirection: "column",
                    background: "linear-gradient(180deg, rgba(10,13,23,0.985) 0%, rgba(6,8,14,0.985) 100%)",
                    border: `1px solid ${accentColor}33`,
                    borderRadius: 20,
                    boxShadow: `0 24px 60px rgba(0,0,0,0.58), 0 0 0 1px rgba(255,255,255,0.02), 0 0 36px ${accentColor}10`,
                    overflow: "hidden",
                    backdropFilter: "blur(16px)",
                  }}
                >
                  <div style={{ padding: "15px 16px 13px", borderBottom: `1px solid ${accentColor}20`, background: `linear-gradient(180deg, ${accentColor}18 0%, rgba(255,255,255,0.01) 100%)` }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                      <span style={{ fontSize: b.isResult ? 18 : 16, color: accentColor, lineHeight: 1.1, marginTop: 1 }}>{icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 800,
                            color: "#f2f6ff",
                            lineHeight: 1.18,
                            letterSpacing: "-0.01em",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {title}
                        </div>
                        <div style={{ fontSize: 10.5, color: "#6d7c9b", marginTop: 4 }}>{meta}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 999, background: "#0d1523", border: "1px solid #17223a", color: accentColor, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        <span>{badge}</span>
                      </div>
                      {sourceDisplay?.hostLabel && (
                        <div style={{ padding: "4px 9px", borderRadius: 999, background: "#0b111d", border: "1px solid #17223a", color: "#8ea2c9", fontSize: 10.5 }}>
                          {sourceDisplay.hostLabel}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "grid", gap: 12 }}>
                    {b.isResult ? (
                      <>
                        {previewLead && (
                          <article
                            style={{
                              padding: "16px 18px",
                              borderRadius: 16,
                              background: "rgba(10,13,23,0.88)",
                              border: "1px solid #141b30",
                              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                              fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                            }}
                          >
                            {renderMarkdownBlocks(previewLead, { compact: true })}
                          </article>
                        )}
                        <div style={{ padding: "14px 16px", borderRadius: 16, background: "#0b111d", border: "1px solid #162134" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#8ca0c7", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                            {previewOutline.length ? "Sections" : "Preview"}
                          </div>
                          {previewOutline.length ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              {previewOutline.map((section, idx) => (
                                <div key={`${section.title}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c" }}>
                                  <div style={{ width: 22, height: 22, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: section.level === 1 ? "#17321c" : "#11192a", color: section.level === 1 ? CATS.result.color : "#8ca0c7", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>
                                    {idx + 1}
                                  </div>
                                  <div style={{ fontSize: 12.5, color: "#d7deef", lineHeight: 1.35, fontWeight: section.level === 1 ? 700 : 600 }}>
                                    {renderMarkdownInline(section.title, `preview-outline-${idx}`)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <article
                              style={{
                                padding: "14px 16px",
                                borderRadius: 14,
                                background: "#0d1522",
                                border: "1px solid #18283c",
                                fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                              }}
                            >
                              {renderMarkdownBlocks(previewText, { compact: true })}
                            </article>
                          )}
                        </div>
                      </>
                    ) : b.sourceUrl && sourceDisplay ? (
                      <>
                        {sourceDisplay.previewImage && (
                          <div style={{ borderRadius: 16, overflow: "hidden", border: "1px solid #18283c", background: "#0b111d" }}>
                            <div style={{ aspectRatio: "16 / 9", background: "linear-gradient(135deg, rgba(15,22,36,0.95) 0%, rgba(8,11,18,0.98) 100%)" }}>
                              <img
                                src={sourceDisplay.previewImage}
                                alt=""
                                referrerPolicy="no-referrer"
                                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                              />
                            </div>
                            <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "rgba(6,8,14,0.72)" }}>
                              <span style={{ fontSize: 10.5, color: "#9fd0ff", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{sourceDisplay.kindLabel}</span>
                              <span style={{ fontSize: 10.5, color: "#6d7c9b" }}>{sourceDisplay.siteName}</span>
                            </div>
                          </div>
                        )}
                        {!sourceDisplay.previewImage && (
                          <div style={{ padding: "14px 16px", borderRadius: 16, background: "#0b111d", border: "1px solid #162134", display: "flex", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 38, height: 38, borderRadius: 12, background: "#0d1522", border: "1px solid #18283c", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {sourceDisplay.faviconUrl ? (
                                <img src={sourceDisplay.faviconUrl} alt="" referrerPolicy="no-referrer" style={{ width: 20, height: 20, objectFit: "contain" }} />
                              ) : (
                                <span style={{ fontSize: 16, color: "#8ea2c9" }}>{sourceDisplay.icon}</span>
                              )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#e6eeff" }}>{sourceDisplay.siteName}</div>
                              <div style={{ fontSize: 11, color: "#7b8aa9", marginTop: 3 }}>{sourceDisplay.kindLabel}</div>
                            </div>
                          </div>
                        )}
                        {(sourceDisplay.lead || sourceDisplay.description) && (
                          <article
                            style={{
                              padding: "14px 16px",
                              borderRadius: 16,
                              background: "rgba(10,13,23,0.88)",
                              border: "1px solid #141b30",
                              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                              fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                            }}
                          >
                            {renderMarkdownBlocks(sourceDisplay.lead || sourceDisplay.description, { compact: true })}
                          </article>
                        )}
                        {sourceDisplay.highlights.length > 0 && (
                          <div style={{ padding: "14px 16px", borderRadius: 16, background: "#0b111d", border: "1px solid #162134" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#8ca0c7", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                              Quick Take
                            </div>
                            <div style={{ display: "grid", gap: 8 }}>
                              {sourceDisplay.highlights.map((bullet, idx) => (
                                <div key={`src-insight-${idx}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c" }}>
                                  <span style={{ color: accentColor, fontSize: 12, lineHeight: 1.3 }}>•</span>
                                  <span style={{ fontSize: 12.5, color: "#d7deef", lineHeight: 1.5 }}>{bullet}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div style={{ padding: "12px 14px", borderRadius: 16, background: "#0b111d", border: "1px solid #162134" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#8ca0c7", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                            Open Source
                          </div>
                          <div style={{ padding: "12px 13px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c", display: "flex", gap: 12, alignItems: "center" }}>
                            <div style={{ width: 34, height: 34, borderRadius: 10, background: "#0b111d", border: "1px solid #1c2b42", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {sourceDisplay.faviconUrl ? (
                                <img src={sourceDisplay.faviconUrl} alt="" referrerPolicy="no-referrer" style={{ width: 18, height: 18, objectFit: "contain" }} />
                              ) : (
                                <span style={{ color: "#8ea2c9", fontSize: 14 }}>{sourceDisplay.icon}</span>
                              )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 11.5, color: "#9fd0ff", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                {sourceDisplay.sourceBadge}
                              </div>
                              <div style={{ fontSize: 10.5, color: "#607190", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceDisplay.canonicalUrl}</div>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <article
                          style={{
                            padding: "16px 18px",
                            borderRadius: 16,
                            background: "rgba(10,13,23,0.88)",
                            border: "1px solid #141b30",
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                            fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                          }}
                        >
                          {renderMarkdownBlocks(previewText, { compact: true })}
                        </article>
                        {insightBullets.length > 0 && (
                          <div style={{ padding: "14px 16px", borderRadius: 16, background: "#0b111d", border: "1px solid #162134" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#8ca0c7", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                              At a Glance
                            </div>
                            <div style={{ display: "grid", gap: 8 }}>
                              {insightBullets.map((bullet, idx) => (
                                <div key={`bubble-insight-${idx}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c" }}>
                                  <span style={{ color: accentColor, fontSize: 12, lineHeight: 1.3 }}>•</span>
                                  <span style={{ fontSize: 12.5, color: "#d7deef", lineHeight: 1.5 }}>{bullet}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div style={{ padding: "10px 16px 14px", fontSize: 10.5, color: "#62708d", borderTop: `1px solid ${accentColor}16`, background: "rgba(6,8,14,0.76)" }}>
                    {actionHint}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Selection count */}
          {S.current.selectedBubbles.size > 0 && (
            <div style={{
              position: "absolute", bottom: 14, left: 14,
              background: "rgba(6,6,16,0.9)", border: "1px solid #4488ff33",
              borderRadius: 6, padding: "4px 12px", fontSize: 10, color: "#4488ff",
              zIndex: 5, pointerEvents: "none",
            }}>
              {S.current.selectedBubbles.size} selected — Del to trash
            </div>
          )}

          {/* Right-click context menu */}
          {ctxMenu && (() => {
            const b = S.current.bubbles.find(b => b.id === ctxMenu.bubbleId);
            if (!b) return null;
            const cat = CATS[bubbleCat(b)] || CATS.default;
            const ac = b.fileType ? b.fileType.color : cat.color;
            const menuW = 150;
            const menuX = Math.min(ctxMenu.x, (canvasRef.current?.parentElement?.clientWidth || 600) - menuW - 10);
            const menuY = Math.min(ctxMenu.y, (canvasRef.current?.parentElement?.clientHeight || 400) - 120);

            const items = [
              { label: "Duplicate", icon: "📋", action: () => ctxCopy(b.id) },
              { label: "Delete", icon: "🗑", action: () => ctxDelete(b.id), color: "#ff6666" },
            ];
            if (S.current.selectedBubbles.size > 1) {
              items.push({ label: `Delete ${S.current.selectedBubbles.size} selected`, icon: "🗑", action: () => { deleteSelected(); setCtxMenu(null); }, color: "#ff6666" });
            }

            return (
              <div
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                style={{
                  position: "absolute", left: menuX, top: menuY, zIndex: 20,
                  background: "#0c0c1a", border: "1px solid #1e1e40", borderRadius: 8,
                  padding: "4px 0", minWidth: menuW,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                }}>
                <div style={{ padding: "5px 12px 3px", borderBottom: "1px solid #14142a", marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: ac, fontWeight: 600 }}>{b.fileType ? b.fileType.icon : cat.icon} {truncate(bubbleSummary(b), 24)}</span>
                </div>
                {items.map((item, i) => (
                  <div key={i}
                    onMouseDown={e => { e.stopPropagation(); item.action(); }}
                    onMouseEnter={e => e.currentTarget.style.background = "#16163a"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    style={{
                      padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                      fontSize: 11, color: item.color || "#aab", transition: "background 0.1s",
                      userSelect: "none",
                    }}>
                    <span style={{ fontSize: 12, width: 18, textAlign: "center" }}>{item.icon}</span>
                    {item.label}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Bubble card overlay — rich markdown rendering */}
          {S.current.expandedBubbleId && (() => {
            const s = S.current;
            const b = s.bubbles.find(b => b.id === s.expandedBubbleId);
            if (!b) return null;
            b.humanRead = true;
            const cW = canvasRef.current?.parentElement?.clientWidth || 800;
            const cH = canvasRef.current?.parentElement?.clientHeight || 600;
            const catKey = bubbleCat(b);
            const cat = CATS[catKey] || CATS.default;
            const accentColor = b.isResult ? CATS.result.color : (b.fileType ? b.fileType.color : cat.color);
            const sourceDisplay = b.sourceUrl ? getSourceDisplayData(b) : null;
            const content = b.items.map(it => it.text).join("\n\n");
            const articleContent = b.sourceUrl
              ? normalizeMarkdownText(sourceDisplay?.description || getSourcePreviewBody(b, 1600) || "Open the source to read the full page.")
              : content;
            const sources = b.resultSources || [];
            const outline = b.isResult ? extractMarkdownOutline(content, 8) : [];
            const insightBullets = !b.isResult ? extractInsightBullets(articleContent || content, 4, 160) : [];
            const headerTitle = b.isResult
              ? (b.resultTitle || "Research Result")
              : sourceDisplay?.title || bubbleSummary(b);
            const headerIcon = b.isResult
              ? "★"
              : sourceDisplay?.icon || (b.fileType ? b.fileType.icon : cat.icon);
            const headerBadge = b.fileType
              ? b.fileType.label
              : b.isResult
              ? "Research Report"
              : sourceDisplay?.kindLabel || catKey.charAt(0).toUpperCase() + catKey.slice(1);
            const metaChips = [
              `${b.items.length} item${b.items.length === 1 ? "" : "s"}`,
              `${b.readers.length} reader${b.readers.length === 1 ? "" : "s"}`,
              b.fileType ? b.fileType.label : null,
              b.isMemory ? "Compressed memory" : null,
              sourceDisplay?.siteName || null,
            ].filter(Boolean);
            const useSplitLayout = cW > 1080;

            return (
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 17 }}>
                <div onClick={() => { S.current.expandedBubbleId = null; rerender(n => n + 1); }}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)" }} />
                <div
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  onWheel={e => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                    width: Math.min(b.isResult ? 1040 : 940, cW - 40), maxHeight: cH - 60,
                    background: "linear-gradient(180deg, #0a0d16 0%, #070912 100%)",
                    border: `1.5px solid ${accentColor}33`,
                    borderRadius: 20, overflow: "hidden", zIndex: 18,
                    boxShadow: `0 16px 60px rgba(0,0,0,0.7), 0 0 40px ${accentColor}15`,
                    display: "flex", flexDirection: "column",
                  }}>
                  <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${accentColor}22`, background: `linear-gradient(180deg, ${accentColor}12 0%, rgba(255,255,255,0.02) 100%)` }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 18 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, minWidth: 0 }}>
                          <span style={{ fontSize: 22, color: accentColor }}>{headerIcon}</span>
                          <span style={{ fontSize: 22, fontWeight: 800, color: accentColor, lineHeight: 1.15, minWidth: 0 }}>{headerTitle}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, background: "#0d1523", border: "1px solid #17223a", color: accentColor, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                            {headerBadge}
                          </div>
                          {metaChips.map((chip, idx) => (
                            <div key={`bubble-chip-${idx}`} style={{ padding: "5px 10px", borderRadius: 999, background: "#0b111d", border: "1px solid #162134", color: "#8091b2", fontSize: 10.5 }}>
                              {chip}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#63708f", whiteSpace: "nowrap", paddingTop: 3 }}>Click outside to close</div>
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px 26px" }}>
                    <div style={{ maxWidth: useSplitLayout ? 980 : 760, margin: "0 auto", display: "grid", gridTemplateColumns: useSplitLayout ? "minmax(0, 1fr) 280px" : "minmax(0, 1fr)", gap: 18, alignItems: "start" }}>
                      <div style={{ minWidth: 0, display: "grid", gap: 16 }}>
                        {sourceDisplay?.previewImage && (
                          <div style={{ borderRadius: 18, overflow: "hidden", border: "1px solid #18283c", background: "#0b111d" }}>
                            <div style={{ aspectRatio: "16 / 9", background: "linear-gradient(135deg, rgba(15,22,36,0.95) 0%, rgba(8,11,18,0.98) 100%)" }}>
                              <img src={sourceDisplay.previewImage} alt="" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            </div>
                          </div>
                        )}
                        <article style={{
                          padding: "22px 24px",
                          borderRadius: 18,
                          background: "rgba(10,13,23,0.9)",
                          border: "1px solid #141b30",
                          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                          fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                        }}>
                          {renderMarkdownBlocks(articleContent)}
                        </article>
                      </div>
                      <aside style={{ display: "grid", gap: 14 }}>
                        {b.isResult && outline.length > 0 && (
                          <div style={{ padding: "15px 16px", borderRadius: 16, background: "#09101a", border: "1px solid #132133" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#7f8fb3", marginBottom: 10, letterSpacing: "0.08em" }}>SECTIONS</div>
                            <div style={{ display: "grid", gap: 8 }}>
                              {outline.map((section, idx) => (
                                <div key={`expanded-outline-${idx}`} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 10px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c" }}>
                                  <div style={{ width: 22, height: 22, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: section.level === 1 ? "#17321c" : "#11192a", color: section.level === 1 ? CATS.result.color : "#8ca0c7", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>
                                    {idx + 1}
                                  </div>
                                  <div style={{ fontSize: 12.5, color: "#d7deef", lineHeight: 1.35 }}>{section.title}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {!b.isResult && insightBullets.length > 0 && (
                          <div style={{ padding: "15px 16px", borderRadius: 16, background: "#09101a", border: "1px solid #132133" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#7f8fb3", marginBottom: 10, letterSpacing: "0.08em" }}>AT A GLANCE</div>
                            <div style={{ display: "grid", gap: 8 }}>
                              {insightBullets.map((bullet, idx) => (
                                <div key={`expanded-insight-${idx}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c" }}>
                                  <span style={{ color: accentColor, fontSize: 12, lineHeight: 1.3 }}>•</span>
                                  <span style={{ fontSize: 12.5, color: "#d7deef", lineHeight: 1.5 }}>{bullet}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {sourceDisplay && (
                          <div style={{ padding: "15px 16px", borderRadius: 16, background: "#09101a", border: "1px solid #132133" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#7f8fb3", marginBottom: 10, letterSpacing: "0.08em" }}>SOURCE</div>
                            <div
                              onClick={() => window.open(sourceDisplay.canonicalUrl || sourceDisplay.url, "_blank")}
                              style={{ display: "flex", gap: 10, alignItems: "center", padding: "11px 12px", borderRadius: 12, background: "#0d1522", border: "1px solid #18283c", cursor: "pointer" }}
                            >
                              <div style={{ width: 36, height: 36, borderRadius: 10, background: "#0b111d", border: "1px solid #1c2b42", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                {sourceDisplay.faviconUrl ? (
                                  <img src={sourceDisplay.faviconUrl} alt="" referrerPolicy="no-referrer" style={{ width: 18, height: 18, objectFit: "contain" }} />
                                ) : (
                                  <span style={{ color: "#8ea2c9", fontSize: 14 }}>{sourceDisplay.icon}</span>
                                )}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11.5, color: "#9fd0ff", lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceDisplay.sourceBadge}</div>
                                <div style={{ fontSize: 10.5, color: "#607190", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceDisplay.canonicalUrl}</div>
                              </div>
                            </div>
                          </div>
                        )}
                        {sources.length > 0 && (
                          <div style={{ padding: "15px 16px", borderRadius: 16, background: "#09101a", border: "1px solid #132133" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#7f8fb3", marginBottom: 10, letterSpacing: "0.08em" }}>SOURCES</div>
                            <div style={{ display: "grid", gap: 8 }}>
                              {sources.map((url, i) => {
                                const sourceInfo = buildSourceDisplayData(url, {});
                                return (
                                  <div
                                    key={i}
                                    onClick={() => window.open(url, "_blank")}
                                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 10, background: "#0d1522", border: "1px solid #18283c", cursor: "pointer" }}
                                    title={url}
                                  >
                                    <span style={{ color: CATS.source.color, fontSize: 11 }}>{sourceInfo.icon}</span>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                      <div style={{ fontSize: 11, color: "#9fd0ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceInfo.hostLabel}</div>
                                      <div style={{ fontSize: 10, color: "#5c6f91", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </aside>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Per-snake config popup — positioned near the snake */}
          {configOpen && (() => {
            const s = S.current;
            const sn = s.snakes.find(sn => sn.id === configOpen);
            if (!sn || !sn.alive) return null;
            const col = PALETTES[sn.colorIdx % PALETTES.length];
            const provider = getSnakeProvider(sn);
            const providerPreset = getProviderPreset(provider);
            const providerHelp = getProviderKeyHelp(provider);
            const selectedModel = providerPreset.models.some(m => m.value === sn.model) ? sn.model : providerPreset.defaultModel;
            const W = canvasRef.current?.parentElement?.clientWidth || 800;
            const H = canvasRef.current?.parentElement?.clientHeight || 600;
            const headScreen = {
              x: sn.segments[0].x - s.camera.x + W / 2,
              y: sn.segments[0].y - s.camera.y + H / 2,
            };
            const popW = 260;
            const popH = 430;
            let px = clamp(headScreen.x + 30, 8, W - popW - 8);
            let py = clamp(headScreen.y - popH / 2, 8, H - popH - 8);

            const inputStyle = {
              width: "100%", background: "#0e0e1e", border: "1px solid #1e1e40",
              borderRadius: 4, padding: "5px 8px", color: "#aab", fontSize: 10.5,
              fontFamily: "'SF Mono','Fira Code',monospace", outline: "none",
            };
            const labelStyle = { fontSize: 9, color: "#556", fontWeight: 600, marginBottom: 2, marginTop: 6, display: "block" };
            const busyReason = getSnakeBusyReason(s, sn);
            const canClearThisSnake = !busyReason && sn.context.length > 0;
            const actionButtonStyle = (enabled, tint) => ({
              flex: 1,
              background: enabled ? `${tint}14` : "transparent",
              border: `1px solid ${enabled ? `${tint}44` : "#1e1e40"}`,
              borderRadius: 6,
              color: enabled ? tint : "#445",
              fontSize: 9.5,
              padding: "6px 8px",
              cursor: enabled ? "pointer" : "not-allowed",
              fontFamily: "inherit",
              opacity: enabled ? 1 : 0.55,
            });

            return (
              <div
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                style={{
                  position: "absolute", left: px, top: py, width: popW, zIndex: 20,
                  background: "#0a0a16", border: `1px solid ${col.body}44`,
                  borderRadius: 10, padding: 0, overflow: "hidden",
                  boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px ${col.body}11`,
                }}>
                <div style={{ padding: "8px 12px", borderBottom: "1px solid #14142a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.head }} />
                    <span style={{ color: col.head, fontSize: 11, fontWeight: 600 }}>⚙ Agent Config</span>
                  </div>
                  <button onMouseDown={e => { e.stopPropagation(); setConfigOpen(null); }} style={{ background: "transparent", border: "none", color: "#444", fontSize: 13, cursor: "pointer" }}>×</button>
                </div>
                <div style={{ padding: "6px 12px 12px" }}>
                  <label style={{ ...labelStyle, marginTop: 0 }}>Name</label>
                  <input value={sn.name}
                    onMouseDown={e => e.stopPropagation()}
                    onChange={e => { sn.name = e.target.value; rerender(n => n + 1); }}
                    style={{ ...inputStyle, fontFamily: "-apple-system, sans-serif", fontWeight: 600 }} />

                  <label style={labelStyle}>Provider</label>
                  <select value={provider}
                    onMouseDown={e => e.stopPropagation()}
                    onChange={e => { applyProviderSelection(sn, e.target.value); rerender(n => n + 1); }}
                    style={{ ...inputStyle, cursor: "pointer" }}>
                    {Object.entries(MODEL_PROVIDER_PRESETS).map(([value, preset]) => (
                      <option key={value} value={value}>{preset.label}</option>
                    ))}
                  </select>

                  <label style={labelStyle}>Model</label>
                  <select value={selectedModel}
                    onMouseDown={e => e.stopPropagation()}
                    onChange={e => { sn.model = e.target.value; sn.apiBase = providerPreset.apiBase; persistSnakeConfig(sn); rerender(n => n + 1); }}
                    style={{ ...inputStyle, cursor: "pointer" }}>
                    {providerPreset.models.map(modelOpt => (
                      <option key={modelOpt.value} value={modelOpt.value}>{modelOpt.label}</option>
                    ))}
                  </select>

                  <label style={labelStyle}>Personal API Key</label>
                  <input value={sn.apiKey} type="password"
                    onMouseDown={e => e.stopPropagation()}
                    onChange={e => { sn.apiKey = e.target.value; persistSnakeConfig(sn); rerender(n => n + 1); }}
                    placeholder={providerHelp.placeholder} style={inputStyle} />

                  <div style={{ marginTop: 8, padding: "9px 10px", borderRadius: 8, background: "#0b111d", border: "1px solid #162134" }}>
                    <div style={{ fontSize: 9.5, color: hasPersonalApiKey(sn) ? "#7fe0b6" : "#ddcc55", fontWeight: 700, marginBottom: 4 }}>
                      {hasPersonalApiKey(sn) ? `${providerPreset.label} key saved in this browser` : `${providerPreset.label} key required for BYOK mode`}
                    </div>
                    <div style={{ fontSize: 8.5, color: "#6f82a4", lineHeight: 1.55 }}>
                      {providerHelp.shortHelp}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button
                        onMouseDown={e => { e.stopPropagation(); window.open(providerHelp.keyUrl, "_blank"); }}
                        style={{ flex: 1, background: "#0d1522", border: "1px solid #1b2b44", borderRadius: 6, color: "#9fd0ff", fontSize: 9, padding: "5px 8px", cursor: "pointer", fontFamily: "inherit" }}
                      >Get key</button>
                      <button
                        onMouseDown={e => { e.stopPropagation(); window.open(providerHelp.docsUrl, "_blank"); }}
                        style={{ flex: 1, background: "#0d1522", border: "1px solid #1b2b44", borderRadius: 6, color: "#8ca0c7", fontSize: 9, padding: "5px 8px", cursor: "pointer", fontFamily: "inherit" }}
                      >Docs</button>
                    </div>
                  </div>

                  <div style={{ fontSize: 8, color: "#334", marginTop: 8, lineHeight: 1.5 }}>
                    ctx: {sn.context.length}/{MAX_CONTEXT} · BYOK mode · key stays in local browser storage
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      onMouseDown={e => { e.stopPropagation(); spawnFreshAgent(sn); setConfigOpen(null); }}
                      style={actionButtonStyle(true, "#80ffdb")}
                    >Fresh Agent</button>
                    <button
                      onMouseDown={e => { e.stopPropagation(); if (canClearThisSnake) clearSnakeContext(sn); }}
                      disabled={!canClearThisSnake}
                      title={busyReason ? `Finish ${busyReason} before clearing context` : sn.context.length ? "Clear this agent's internal memory" : "Agent is already clean"}
                      style={actionButtonStyle(canClearThisSnake, "#ffb86b")}
                    >Clear Context</button>
                  </div>
                  <div style={{ fontSize: 8, color: "#334", marginTop: 6, lineHeight: 1.5 }}>
                    {busyReason ? `Context reset disabled while ${busyReason}.` : "Fresh Agent keeps model settings but starts with empty context."}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Activity log panel */}
          {logOpen && (() => {
            const entries = _activityLog.slice(-80).reverse();
            const AC = { request: "#66aaff", response: "#22d65b", "rate-limited": "#e6a020", "research:start": "#5ce0d8", "research:plan": "#5ce0d8", "research:search": "#55aadd", "research:found": "#22d65b", "research:merged": "#80ffdb", "research:reflect": "#e0aaff", "research:sufficient": "#66ff88", "research:synthesize": "#66ff88", "research:done": "#22d65b", "research:error": "#ff6666", "error": "#ff6666", exception: "#ff6666", "timeout 30s": "#ff6666" };
            return (
              <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} style={{ position: "absolute", bottom: 50, left: 10, width: 400, height: 260, zIndex: 16, background: "#080810", border: "1px solid #1a1a3a", borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "6px 10px", borderBottom: "1px solid #14142a", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                  <span style={{ color: "#5ce0d8", fontSize: 11, fontWeight: 600 }}>📋 Activity Log</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { _activityLog.length = 0; rerender(n => n + 1); }} style={{ background: "transparent", border: "1px solid #22224433", borderRadius: 4, color: "#445", fontSize: 8, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
                    <button onClick={() => setLogOpen(false)} style={{ background: "transparent", border: "none", color: "#444", fontSize: 13, cursor: "pointer" }}>×</button>
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "4px 0", fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 9, lineHeight: 1.7 }}>
                  {entries.length === 0 && <div style={{ color: "#222240", textAlign: "center", padding: 20, fontStyle: "italic", fontFamily: "-apple-system, sans-serif" }}>No activity yet</div>}
                  {entries.map((e, i) => {
                    const t = new Date(e.time);
                    const ts = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
                    return <div key={entries.length - i} style={{ padding: "1px 10px", borderBottom: "1px solid #0c0c1a" }}><span style={{ color: "#334" }}>{ts}</span> <span style={{ color: "#888" }}>{e.agent}</span> <span style={{ color: AC[e.action] || "#556", fontWeight: 600 }}>{e.action}</span>{e.detail && <span style={{ color: "#445" }}> {e.detail}</span>}</div>;
                  })}
                </div>
              </div>
            );
          })()}

          {/* Map management popup */}
          {mapMenuOpen && (
            <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, right: 8, width: 260, maxHeight: "60vh", zIndex: 16, background: "#0a0a16", border: "1px solid #1a1a3a", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #14142a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ color: "#66aaff", fontSize: 12, fontWeight: 600 }}>Sessions</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { newMap(); setMapMenuOpen(false); }} style={{ background: "transparent", border: "1px solid #22d65b33", borderRadius: 4, color: "#22d65b", fontSize: 9, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>+ New</button>
                  <button onClick={() => setMapMenuOpen(false)} style={{ background: "transparent", border: "none", color: "#444", fontSize: 14, cursor: "pointer" }}>×</button>
                </div>
              </div>
              <div style={{ padding: "9px 12px", borderBottom: "1px solid #14142a", fontSize: 9, color: "#556", lineHeight: 1.5 }}>
                Sessions auto-save locally. New starts a fresh canvas and keeps this one in the list.
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
                {Storage.listMaps().length === 0 && <div style={{ color: "#222240", fontSize: 11, fontStyle: "italic", padding: "16px 0", textAlign: "center" }}>No cached sessions yet</div>}
                {Storage.listMaps()
                  .map(name => ({ name, data: Storage.loadMap(name) }))
                  .sort((a, b) => (b.data?.savedAt || 0) - (a.data?.savedAt || 0))
                  .map(({ name, data }) => {
                  const info = data ? `${data.bubbles?.length || 0} bubbles · ${data.snakes?.length || 0} agents` : "corrupted";
                  const isCurrent = name === mapName;
                  const savedAtLabel = data?.savedAt
                    ? new Date(data.savedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                    : "unknown time";
                  return (
                    <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", marginBottom: 3, borderRadius: 6, background: isCurrent ? "#0e1a2a" : "#0c0c18", border: `1px solid ${isCurrent ? "#336699" : "#14142a"}`, cursor: "pointer" }}
                      onClick={() => {
                        if (name !== mapName && hasSessionContent()) persistMapState(mapName);
                        const d = Storage.loadMap(name);
                        if (d) { loadMapData(d); setMapName(name); Storage.saveLastMap(name); }
                        setMapMenuOpen(false);
                      }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: isCurrent ? "#66aaff" : "#888", fontWeight: isCurrent ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                        <div style={{ fontSize: 8, color: "#334" }}>{savedAtLabel} · {info}</div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); Storage.deleteMap(name); rerender(n => n + 1); }} style={{ background: "transparent", border: "none", color: "#ff666644", fontSize: 11, cursor: "pointer", padding: "2px 4px" }} title="Delete">×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Trash floating popup */}
          {trashOpen && (
            <div style={{
              position: "absolute", top: 8, right: 8, width: 280, maxHeight: "60vh", zIndex: 15,
              background: "#0a0a16", border: "1px solid #1a1a3a", borderRadius: 10,
              boxShadow: "0 12px 40px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden",
            }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #14142a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ color: "#888", fontSize: 12, fontWeight: 600 }}>🗑 Trash ({S.current.trash.length})</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {S.current.trash.length > 0 && (
                    <button onClick={emptyTrash} style={{ background: "transparent", border: "1px solid #ff444433", borderRadius: 4, color: "#ff6666", fontSize: 9, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>Empty all</button>
                  )}
                  <button onClick={() => setTrashOpen(false)} style={{ background: "transparent", border: "none", color: "#444", fontSize: 14, cursor: "pointer" }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
                {S.current.trash.length === 0 && (
                  <div style={{ color: "#222240", fontSize: 11, fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>Trash is empty</div>
                )}
                {S.current.trash.map(b => {
                  const cat = CATS[bubbleCat(b)] || CATS.default;
                  const acColor = b.fileType ? b.fileType.color : cat.color;
                  return (
                    <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4, borderRadius: 6, background: "#0c0c18", border: "1px solid #14142a" }}>
                      <span style={{ fontSize: 11, color: acColor, flexShrink: 0 }}>{b.fileType ? b.fileType.icon : cat.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bubbleSummary(b)}</div>
                        <div style={{ fontSize: 8, color: "#334" }}>{b.items.length} item{b.items.length > 1 ? "s" : ""}</div>
                      </div>
                      <button onClick={() => restoreFromTrash(b.id)} style={{ background: "transparent", border: "1px solid #22d65b33", borderRadius: 4, color: "#22d65b", fontSize: 8, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>Restore</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* drop zone hint */}
          <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", color: "#1a1a40", fontSize: 11, pointerEvents: "none" }}>
            drop files or documents to add to the knowledge map
          </div>
        </div>

        {/* ═══ RESULT PANEL — right sidebar ═══ */}
        {S.current.activeResultId && (() => {
          const s = S.current;
          const r = s.results.find(r => r.id === s.activeResultId);
          if (!r) return null;
          return (
            <div style={{ width: "clamp(460px, 38vw, 620px)", flexShrink: 0, background: "linear-gradient(180deg, #060812 0%, #05060d 100%)", borderLeft: "1px solid #101b26", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "inset 1px 0 0 rgba(255,255,255,0.02)" }}>
              <div style={{ padding: "20px 22px 14px", borderBottom: "1px solid #18311e", background: "linear-gradient(180deg, rgba(102,255,136,0.08) 0%, rgba(102,255,136,0.02) 100%)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 22, color: "#66ff88", lineHeight: 1 }}>★</span>
                    <span style={{ fontSize: 24, fontWeight: 800, color: "#66ff88", lineHeight: 1.12, letterSpacing: "-0.02em" }}>{r.title}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#6b7897" }}>by {r.snakeName} · {new Date(r.createdAt).toLocaleTimeString()}{s.results.length > 1 ? ` · ${s.results.length} results` : ""}</div>
                </div>
                <button onClick={() => { S.current.activeResultId = null; rerender(n => n + 1); }} style={{ background: "transparent", border: "none", color: "#5b6a86", fontSize: 18, cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>×</button>
              </div>
              {s.results.length > 1 && (
                <div style={{ display: "flex", gap: 6, padding: "10px 16px", borderBottom: "1px solid #10192a", flexShrink: 0, overflowX: "auto", background: "rgba(6,10,20,0.75)" }}>
                  {s.results.map(res => (
                    <button key={res.id} onClick={() => { S.current.activeResultId = res.id; rerender(n => n + 1); }} style={{ background: res.id === s.activeResultId ? "#66ff881c" : "#0c101b", border: `1px solid ${res.id === s.activeResultId ? "#66ff8840" : "#172033"}`, borderRadius: 999, padding: "5px 10px", fontSize: 10, cursor: "pointer", color: res.id === s.activeResultId ? "#66ff88" : "#627191", fontFamily: "inherit", whiteSpace: "nowrap" }}>{truncate(res.title, 22)}</button>
                  ))}
                </div>
              )}
              <div style={{ flex: 1, overflowY: "auto", padding: "22px 22px 28px" }}>
                <article style={{
                  maxWidth: 720,
                  margin: "0 auto",
                  padding: "24px 26px 26px",
                  borderRadius: 20,
                  background: "rgba(10,13,23,0.92)",
                  border: "1px solid #141c30",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03), 0 18px 40px rgba(0,0,0,0.2)",
                  fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
                }}>
                  {renderMarkdownBlocks(r.content)}
                </article>
                {r.sources?.length > 0 && (
                  <div style={{ maxWidth: 720, margin: "18px auto 0", padding: "16px 18px", borderRadius: 16, background: "#09101a", border: "1px solid #132133" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#7f8fb3", marginBottom: 10, letterSpacing: "0.08em" }}>SOURCES</div>
                    {r.sources.map((url, i) => {
                      let domain = url; try { domain = new URL(url).hostname.replace("www.", ""); } catch {}
                      return <div key={i} onClick={() => window.open(url, "_blank")} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, borderRadius: 12, background: "#0d1522", border: "1px solid #18283c", cursor: "pointer" }} onMouseEnter={e => e.currentTarget.style.borderColor = "#55aadd44"} onMouseLeave={e => e.currentTarget.style.borderColor = "#18283c"}><span style={{ color: "#55aadd", fontSize: 11 }}>🔗</span><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, color: "#9fd0ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{domain}</div><div style={{ fontSize: 10, color: "#5c6f91", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</div></div></div>;
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      </div>

      {/* input */}
      {(() => {
        const selectedSnake = getSelectedSnake(S.current);
        const isResearching = !!selectedSnake?._researchPhase;
        const targetHasKey = hasPersonalApiKey(selectedSnake);
        const targetColor = selectedSnake ? PALETTES[selectedSnake.colorIdx % PALETTES.length].head : "#ff9a7a";
        const hasTarget = !!selectedSnake;
        const steerBorder = !hasTarget ? "#7a3f3322" : !targetHasKey ? "#6b533022" : isResearching ? "#5ce0d833" : "#16163a";
        const steerBg = !hasTarget ? "#130c0d" : !targetHasKey ? "#141108" : isResearching ? "#0b1218" : "#0b0b18";
        const placeholder = !hasTarget
          ? "Select a snake first, then send a task…"
          : !targetHasKey
          ? `Add your ${getProviderPreset(getSnakeProvider(selectedSnake)).label} key for ${selectedSnake.name} first…`
          : isResearching
          ? `Steer ${selectedSnake.name}… (e.g. focus on costs)`
          : `Ask ${selectedSnake.name} to research anything…`;
        const sendDisabled = !hasTarget || (targetHasKey && !input.trim());
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", background: "#080812", borderTop: `1px solid ${isResearching ? "#5ce0d822" : "#10102a"}`, zIndex: 10, flexShrink: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                height: 34,
                borderRadius: 999,
                background: hasTarget ? "#0d1522" : "#160d0f",
                border: `1px solid ${hasTarget ? `${targetColor}33` : "#6b3a3044"}`,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
              title={hasTarget ? `Targeting ${selectedSnake.name}` : "Click a snake head to target it"}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: targetColor, boxShadow: hasTarget ? `0 0 10px ${targetColor}` : "none" }} />
              <span style={{ fontSize: 10.5, color: hasTarget ? "#d8e6ff" : "#d59a8f", fontWeight: 700 }}>
                {hasTarget ? `Target: ${selectedSnake.name}` : "No target"}
              </span>
              {hasTarget && !targetHasKey && <span style={{ fontSize: 9, color: "#ddcc55", opacity: 0.85 }}>key needed</span>}
              {isResearching && <span style={{ fontSize: 9, color: "#5ce0d8", opacity: 0.8 }}>steering</span>}
            </div>
            <div style={{ flex: 1, display: "flex", background: steerBg, borderRadius: 7, border: `1px solid ${steerBorder}`, padding: "0 10px" }}>
              <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") sendMessage(); }}
                placeholder={placeholder}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: !hasTarget ? "#c19a92" : isResearching ? "#5ce0d8" : "#a0a0b8", padding: "9px 0", fontSize: 12.5, fontFamily: "inherit" }}
              />
            </div>
            {!hasTarget && <span style={{ color: "#7d5f5a", fontSize: 10.5, flexShrink: 0 }}>Click a snake head to target it</span>}
            {hasTarget && !targetHasKey && <span style={{ color: "#8f845b", fontSize: 10.5, flexShrink: 0 }}>Open Agent Config and paste your personal key</span>}
            <button onClick={() => { if (hasTarget && !targetHasKey) { setConfigOpen(selectedSnake.id); return; } sendMessage(); }} disabled={sendDisabled} style={{
              background: !sendDisabled ? (!targetHasKey ? "#ddcc55" : isResearching ? "#5ce0d8" : "#22d65b") : "#10102a",
              color: !sendDisabled ? "#050510" : "#333",
              border: "none", borderRadius: 7, padding: "9px 16px", fontSize: 12.5, fontWeight: 700,
              cursor: !sendDisabled ? "pointer" : "default", fontFamily: "inherit",
            }}>{!hasTarget ? "Select snake" : !targetHasKey ? "Set key" : isResearching ? "Steer" : "Send"}</button>
          </div>
        );
      })()}

      {/* ═══ DEBUG PANEL — full overlay ═══ */}
      {debugOpen && (() => {
        const s = S.current;
        const entries = _activityLog.slice(-200).reverse();
        const snakes = s.snakes.filter(sn => sn.alive);
        const levelColors = { info: "#556", warn: "#e6a020", error: "#ff4444" };
        const actionColors = {
          request: "#4488cc", response: "#22aa55", "rate-limited": "#e6a020",
          timeout: "#ff4444", exception: "#ff4444", error: "#ff4444",
          "research:start": "#5ce0d8", "research:plan": "#66aaff", "research:search": "#55aadd",
          "research:found": "#22d65b", "research:merged": "#80ffdb", "research:reflect": "#dd88ff",
          "research:sufficient": "#66ff88", "research:synthesize": "#66ff88", "research:done": "#22d65b",
          "research:error": "#ff4444", "research:no-results": "#e6a020",
        };
        return (
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, background: "#050510ee", display: "flex", flexDirection: "column", fontFamily: "'SF Mono','Fira Code',Consolas,monospace" }}>
            {/* debug header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #1a1a30", flexShrink: 0 }}>
              <span style={{ color: "#ff8844", fontSize: 14, fontWeight: 700 }}>🐛 Debug Console</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: "#334", fontSize: 10 }}>{_activityLog.length} entries · {snakes.length} snakes</span>
                <button onClick={() => { _activityLog.length = 0; rerender(n => n + 1); }} style={{ background: "transparent", border: "1px solid #33222244", borderRadius: 4, color: "#664", fontSize: 9, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>
                <button onClick={() => setDebugOpen(false)} style={{ background: "#ff884422", border: "1px solid #ff884444", borderRadius: 4, color: "#ff8844", fontSize: 10, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
              </div>
            </div>

            {/* snake status cards */}
            <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid #1a1a30", flexShrink: 0, overflowX: "auto" }}>
              {snakes.map(sn => {
                const col = PALETTES[sn.colorIdx % PALETTES.length];
                return (
                  <div key={sn.id} style={{ background: "#0a0a18", border: `1px solid ${col.head}33`, borderRadius: 8, padding: "8px 12px", minWidth: 200, flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: sn._researchPhase ? "#5ce0d8" : sn.isThinking ? col.head : "#333" }} />
                      <span style={{ color: col.head, fontSize: 11, fontWeight: 700 }}>{sn.name}</span>
                    </div>
                    <div style={{ fontSize: 9, color: "#556", lineHeight: 1.6 }}>
                      <div>Model: <span style={{ color: "#888" }}>{sn.model}</span></div>
                      <div>Provider: <span style={{ color: "#888" }}>{getSnakeProviderLabel(sn)}</span></div>
                      <div>Key: <span style={{ color: sn.apiKey ? "#22d65b" : "#ff4444" }}>{sn.apiKey ? "✓ set" : "✗ missing"}</span></div>
                      <div>Context: <span style={{ color: "#888" }}>{sn.context.length} items</span></div>
                      <div>Phase: <span style={{ color: sn._researchPhase ? "#5ce0d8" : sn.isThinking ? "#e6a020" : "#334" }}>{sn._researchPhase || (sn.isThinking ? "thinking" : sn._errorCooldown && Date.now() < sn._errorCooldown ? `cooldown ${Math.ceil((sn._errorCooldown - Date.now()) / 1000)}s` : "idle")}</span></div>
                      {sn.task && <div>Task: <span style={{ color: "#aab" }}>{sn.task.slice(0, 40)}</span></div>}
                      {sn._steeringNotes?.length > 0 && <div>Steering: <span style={{ color: "#5ce0d8" }}>{sn._steeringNotes.length} notes</span></div>}
                      {sn._humanPins?.length > 0 && <div>Pins: <span style={{ color: "#5ce0d8" }}>{sn._humanPins.length} bubbles</span></div>}
                    </div>
                  </div>
                );
              })}
              {snakes.length === 0 && <div style={{ color: "#334", fontSize: 11, fontStyle: "italic" }}>No live snakes</div>}
            </div>

            {/* log stream */}
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
              {entries.length === 0 && <div style={{ color: "#222240", textAlign: "center", padding: 40, fontStyle: "italic", fontSize: 12 }}>No activity yet. Ask the snake to research something.</div>}
              {entries.map((e, i) => {
                const t = new Date(e.time);
                const ts = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}.${String(t.getMilliseconds()).padStart(3,"0")}`;
                const ac = actionColors[e.action] || levelColors[e.level] || "#556";
                const isError = e.level === "error";
                const isLong = e.detail.length > 120;
                return (
                  <div key={entries.length - i} style={{ padding: "3px 16px", borderLeft: `3px solid ${isError ? "#ff444444" : "transparent"}`, background: isError ? "#ff440008" : "transparent", borderBottom: "1px solid #0a0a14" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ color: "#2a2a40", fontSize: 9, flexShrink: 0, width: 72 }}>{ts}</span>
                      <span style={{ color: "#666", fontSize: 9, flexShrink: 0, width: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.agent}</span>
                      <span style={{ color: ac, fontSize: 9.5, fontWeight: 700, flexShrink: 0, minWidth: 100 }}>{e.action}</span>
                      <span style={{ color: isError ? "#cc6666" : "#445", fontSize: 9, wordBreak: "break-all", lineHeight: 1.5 }}>{isLong ? e.detail : e.detail}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* bottom bar */}
            <div style={{ padding: "6px 16px", borderTop: "1px solid #1a1a30", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "#334", fontSize: 9 }}>Bubbles: {s.bubbles.length} · Sources: {s.bubbles.filter(b => b.sourceUrl).length} · Results: {(s.results || []).length} · Settled: {s.bubbles.filter(b => b.settled).length}</span>
              <span style={{ color: "#334", fontSize: 9 }}>Press Esc or click Close to dismiss</span>
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #16163a; border-radius: 2px; }
        ::-webkit-scrollbar-track { background: transparent; }
      `}</style>
    </div>
  );
}
