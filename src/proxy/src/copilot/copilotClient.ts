import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import type { CopilotTokenData } from './copilotToken.js';

export const COPILOT_API_PATHS = ['/chat/completions', '/v1/messages', '/responses'] as const;
export const COPILOT_FORWARD_PATHS = ['/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/responses'] as const;
export type CopilotApiPath = (typeof COPILOT_FORWARD_PATHS)[number];
type ModelsCacheKey = string;

interface ModelsSnapshot {
  models: ModelInfo[];
  pathMap: Map<string, CopilotApiPath[]>;
  fetchedAt: number;
  expiresAt: number;
}

interface ModelsCacheEntry {
  snapshot?: ModelsSnapshot;
  refreshPromise?: Promise<ModelsSnapshot>;
}

export interface ModelInfo {
  id: string;
  [key: string]: unknown;
}

export interface ForwardCopilotRequestOptions {
  claudeCodeOptimized?: boolean;
  anthropicVersion?: string;
  anthropicBeta?: string;
  visionRequest?: boolean;
  initiator?: 'user' | 'agent';
  interactionType?: string;
}

export class CopilotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CopilotApiError';
  }
}

export class CopilotModelPathError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'CopilotModelPathError';
  }
}

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const MODELS_CACHE_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const MODELS_CACHE_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MODELS_CACHE_NEGATIVE_RECHECK_MS = 60 * 1000;
const modelsCache = new Map<ModelsCacheKey, ModelsCacheEntry>();
const modelsCacheLogger = new Logger('models-cache');

export async function listModels(copilot: CopilotTokenData): Promise<ModelInfo[]> {
  const snapshot = await getModelsSnapshot(copilot);
  return snapshot.models;
}

async function fetchModels(copilot: CopilotTokenData): Promise<ModelInfo[]> {
  const res = await fetch(copilotUrl(copilot, '/models'), { headers: copilotHeaders(copilot) });
  if (!res.ok) throw new CopilotApiError(`List models failed: ${res.status} ${await res.text()}`, res.status);
  const data = (await res.json()) as { data?: ModelInfo[] };
  return data.data ?? [];
}

export async function forwardCopilotRequest(
  copilot: CopilotTokenData,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  options: ForwardCopilotRequestOptions = {},
): Promise<Response> {
  return fetch(copilotUrl(copilot, path), {
    method: 'POST',
    headers: copilotHeaders(copilot, body.stream === true, options),
    body: JSON.stringify(body),
  });
}

export async function assertModelSupportsPath(
  copilot: CopilotTokenData,
  path: CopilotApiPath,
  model: string,
): Promise<void> {
  const capabilityPath = modelCapabilityPath(path);
  let snapshot = await getModelsSnapshot(copilot);
  let supportedPaths = snapshot.pathMap.get(model);
  if (supportedPaths?.includes(capabilityPath)) return;

  if (Date.now() - snapshot.fetchedAt > MODELS_CACHE_NEGATIVE_RECHECK_MS) {
    snapshot = await getModelsSnapshot(copilot, { forceRefresh: true, allowStaleOnError: false });
    supportedPaths = snapshot.pathMap.get(model);
    if (supportedPaths?.includes(capabilityPath)) return;
  }

  throw modelPathError(model, path, supportedPaths);
}

export function modelSupportsPath(model: ModelInfo, path: CopilotApiPath): boolean {
  return inferSupportedPaths(model).includes(modelCapabilityPath(path));
}

async function getModelsSnapshot(
  copilot: CopilotTokenData,
  options: { forceRefresh?: boolean; allowStaleOnError?: boolean } = {},
): Promise<ModelsSnapshot> {
  const cacheKey = modelsCacheKey(copilot);
  const entry = modelsCacheEntry(cacheKey);
  const now = Date.now();
  const snapshot = entry.snapshot;
  if (!options.forceRefresh && snapshot && snapshot.expiresAt > now) {
    if (snapshot.expiresAt - now <= MODELS_CACHE_REFRESH_AHEAD_MS) refreshModelsInBackground(cacheKey, copilot, entry);
    return snapshot;
  }

  try {
    return await refreshModelsSnapshot(cacheKey, copilot, entry);
  } catch (err) {
    if (options.allowStaleOnError !== false && snapshot && now - snapshot.fetchedAt <= MODELS_CACHE_STALE_MAX_AGE_MS) {
      modelsCacheLogger.warn('refresh-failed-stale', 'Using stale Copilot models cache after refresh failed', {
        cacheKey,
        ageSeconds: Math.round((now - snapshot.fetchedAt) / 1000),
        error: errorMessage(err),
      });
      return snapshot;
    }
    throw err;
  }
}

function modelsCacheEntry(cacheKey: ModelsCacheKey): ModelsCacheEntry {
  const existing = modelsCache.get(cacheKey);
  if (existing) return existing;
  const created: ModelsCacheEntry = {};
  modelsCache.set(cacheKey, created);
  return created;
}

function refreshModelsInBackground(cacheKey: ModelsCacheKey, copilot: CopilotTokenData, entry: ModelsCacheEntry): void {
  if (entry.refreshPromise) return;
  void refreshModelsSnapshot(cacheKey, copilot, entry).catch((err: unknown) => {
    modelsCacheLogger.warn('background-refresh-failed', 'Copilot models cache background refresh failed', {
      cacheKey,
      error: errorMessage(err),
    });
  });
}

function refreshModelsSnapshot(
  cacheKey: ModelsCacheKey,
  copilot: CopilotTokenData,
  entry: ModelsCacheEntry,
): Promise<ModelsSnapshot> {
  if (entry.refreshPromise) return entry.refreshPromise;

  const promise = fetchModels(copilot)
    .then((models) => {
      const now = Date.now();
      const snapshot: ModelsSnapshot = {
        models,
        pathMap: buildPathMap(models),
        fetchedAt: now,
        expiresAt: now + MODELS_CACHE_TTL_MS,
      };
      entry.snapshot = snapshot;
      modelsCacheLogger.info('refresh-done', 'Refreshed Copilot models cache', {
        cacheKey,
        modelCount: models.length,
        ttlSeconds: Math.round(MODELS_CACHE_TTL_MS / 1000),
      });
      return snapshot;
    })
    .finally(() => {
      if (entry.refreshPromise === promise) entry.refreshPromise = undefined;
    });

  entry.refreshPromise = promise;
  return promise;
}

function buildPathMap(models: ModelInfo[]): Map<string, CopilotApiPath[]> {
  const pathMap = new Map<string, CopilotApiPath[]>();
  for (const model of models) pathMap.set(model.id, inferSupportedPaths(model));
  return pathMap;
}

function modelPathError(model: string, path: CopilotApiPath, supportedPaths: CopilotApiPath[] | undefined): CopilotModelPathError {
  if (!supportedPaths) return new CopilotModelPathError(`Unknown Copilot model "${model}". Check GET /v1/models for available models.`);
  if (supportedPaths.length === 0) {
    return new CopilotModelPathError(
      `Cannot determine a supported Copilot LLM API path for model "${model}". Check GET /v1/models for model metadata.`,
    );
  }
  return new CopilotModelPathError(`Model "${model}" is not available on ${path}. Supported path(s): ${supportedPaths.join(', ')}.`);
}

function modelsCacheKey(copilot: CopilotTokenData): ModelsCacheKey {
  const fields = copilotTokenFields(copilot.token);
  const fromSku = accountTypeFromText(fields.get('sku'));
  if (fromSku) return fromSku;
  const fromProxyEndpoint = accountTypeFromText(fields.get('proxy-ep'));
  if (fromProxyEndpoint) return fromProxyEndpoint;
  const fromApi = accountTypeFromText(copilot.api);
  if (fromApi) return fromApi;
  try {
    return new URL(copilot.api).host;
  } catch {
    return 'default';
  }
}

function copilotTokenFields(token: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of token.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    fields.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim());
  }
  return fields;
}

function accountTypeFromText(value: string | undefined): ModelsCacheKey | undefined {
  const normalized = value?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('enterprise')) return 'enterprise';
  if (normalized.includes('business')) return 'business';
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function copilotHeaders(
  copilot: CopilotTokenData,
  acceptsStream = false,
  options: ForwardCopilotRequestOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilot.token}`,
    'Content-Type': 'application/json',
    Accept: acceptsStream ? 'text/event-stream' : 'application/json',
    'Openai-Intent': 'conversation-panel',
    'X-Request-Id': randomUUID(),
    ...config.editorHeaders,
  };
  if (options.claudeCodeOptimized) {
    headers['X-GitHub-Api-Version'] = config.claudeCodeOptimizedEditorHeaders['X-GitHub-Api-Version'];
    headers['Copilot-Integration-Id'] = config.claudeCodeOptimizedEditorHeaders['Copilot-Integration-Id'];
    headers['VScode-SessionId'] = config.claudeCodeOptimizedEditorHeaders['VScode-SessionId'];
    headers['VScode-MachineId'] = config.claudeCodeOptimizedEditorHeaders['VScode-MachineId'];
    headers['Editor-Device-Id'] = config.claudeCodeOptimizedEditorHeaders['Editor-Device-Id'];
    headers['Editor-Version'] = config.claudeCodeOptimizedEditorHeaders['Editor-Version'];
    headers['Editor-Plugin-Version'] = config.claudeCodeOptimizedEditorHeaders['Editor-Plugin-Version'];
    headers['User-Agent'] = config.claudeCodeOptimizedEditorHeaders['User-Agent'];
    if (options.anthropicVersion) headers['anthropic-version'] = options.anthropicVersion;
    if (options.anthropicBeta) headers['anthropic-beta'] = options.anthropicBeta;
    if (options.visionRequest) headers['Copilot-Vision-Request'] = 'true';
    if (options.initiator) headers['x-initiator'] = options.initiator;
    if (options.interactionType) headers['x-interaction-type'] = options.interactionType;
  }
  return headers;
}

function copilotUrl(copilot: CopilotTokenData, path: string): string {
  return `${copilot.api.replace(/\/+$/, '')}${path}`;
}

function inferSupportedPaths(model: ModelInfo): CopilotApiPath[] {
  const metadataPaths = collectMetadataPathHints(model);
  if (metadataPaths.length > 0) return metadataPaths;
  const id = model.id.toLowerCase();
  if (/\b(claude|anthropic)\b/.test(id)) return ['/v1/messages'];
  if (/(^|[-_.])gpt[-_.]?5($|[-_.])|(^|[-_.])codex($|[-_.])|(^|[-_.])o\d($|[-_.])/.test(id)) return ['/responses'];
  if (/\b(gpt|openai|gemini|llama|mistral)\b/.test(id)) return ['/chat/completions'];
  if (capabilityType(model) === 'chat') return ['/chat/completions'];
  return [];
}

function modelCapabilityPath(path: CopilotApiPath): CopilotApiPath {
  return path === '/v1/messages/count_tokens' ? '/v1/messages' : path;
}

function capabilityType(model: ModelInfo): string | undefined {
  const capabilities = model.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return undefined;
  const type = (capabilities as Record<string, unknown>).type;
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

function collectMetadataPathHints(value: unknown, key = ''): CopilotApiPath[] {
  const found = new Set<CopilotApiPath>();
  collectMetadataPathHintsInto(value, key, found);
  return [...found];
}

function collectMetadataPathHintsInto(value: unknown, key: string, found: Set<CopilotApiPath>): void {
  if (typeof value === 'string') {
    const path = pathHintFromString(value, key);
    if (path) found.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMetadataPathHintsInto(item, key, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) collectMetadataPathHintsInto(childValue, childKey, found);
}

function pathHintFromString(value: string, key: string): CopilotApiPath | undefined {
  const normalized = value.trim().toLowerCase();
  const normalizedKey = key.toLowerCase();
  if (normalized.includes('/chat/completions') || normalized.includes('chat_completions')) return '/chat/completions';
  if (normalized.includes('/v1/messages') || normalized.includes('anthropic_messages')) return '/v1/messages';
  if (normalized.includes('/responses') || normalized.includes('responses_api')) return '/responses';
  if (!/(endpoint|api|path|route|capabilit)/.test(normalizedKey)) return undefined;
  if (/^chat[-_. ]?completions$/.test(normalized)) return '/chat/completions';
  if (/^(v1[-_/])?messages$/.test(normalized) || normalized === 'anthropic') return '/v1/messages';
  if (normalized === 'responses' || normalized === 'response') return '/responses';
  return undefined;
}
