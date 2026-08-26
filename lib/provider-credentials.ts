import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { prisma } from "@/lib/prisma";

export const DEEPSEEK_PROVIDER = "DEEPSEEK" as const;
export const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

const ENCRYPTION_VERSION = "v1";
const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_LENGTH = 512;

export type DeepSeekCredentialInput = {
  apiKey: string;
  apiBase?: string;
  model?: string;
};

export type DeepSeekConnectionResult = {
  apiBase: string;
  models: string[];
};

export type DeepSeekCredentialStatus = {
  connected: boolean;
  apiBase: string;
  model: string;
  keyHint: string | null;
  lastTestedAt: string | null;
  error: string | null;
};

export type ProjectDeepSeekCredential = {
  apiKey: string;
  apiBase: string;
  model: string;
};

function credentialEncryptionKey(): Buffer {
  const configured = process.env.DIRECTOR_CREDENTIAL_KEY?.trim();
  if (!configured || configured.length < 32) {
    throw new Error("缺少 DIRECTOR_CREDENTIAL_KEY：请在本机 .env 配置至少 32 个字符的随机加密密钥。");
  }
  return createHash("sha256").update(configured, "utf8").digest();
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function encryptSecret(secret: string): string {
  if (!secret) throw new Error("不能加密空凭证。");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, credentialEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, encode(iv), encode(tag), encode(ciphertext)].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivText, tagText, ciphertextText, extra] = payload.split(".");
  if (extra !== undefined || version !== ENCRYPTION_VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error("API 凭证加密格式无效。");
  }
  const iv = decode(ivText);
  const tag = decode(tagText);
  const ciphertext = decode(ciphertextText);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new Error("API 凭证加密内容无效。");
  }
  try {
    const decipher = createDecipheriv(CIPHER, credentialEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("API 凭证无法解密：请确认 DIRECTOR_CREDENTIAL_KEY 未被更换。");
  }
}

export function normalizeDeepSeekBase(value: string | undefined | null): string {
  const candidate = (value ?? DEFAULT_DEEPSEEK_BASE).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("DeepSeek API 地址无效，请填写完整的 http(s) 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("DeepSeek API 地址只支持不带账号信息的 http(s) 地址。");
  }
  return url.toString().replace(/\/+$/, "");
}

export function normalizeDeepSeekModel(value: string | undefined | null): string {
  const model = (value ?? DEFAULT_DEEPSEEK_MODEL).trim();
  if (!model || model.length > 128 || /[\r\n]/.test(model)) {
    throw new Error("DeepSeek 模型名称无效。");
  }
  return model;
}

export function validateDeepSeekApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length < 8 || apiKey.length > MAX_KEY_LENGTH || /[\r\n]/.test(apiKey)) {
    throw new Error("DeepSeek API Key 长度或格式无效。");
  }
  return apiKey;
}

export function maskApiKey(apiKey: string): string {
  const normalized = validateDeepSeekApiKey(apiKey);
  return `••••••${normalized.slice(-4)}`;
}

function connectionError(status: number): Error {
  if (status === 401 || status === 403) return new Error("DeepSeek API Key 无效或没有访问权限。");
  if (status === 429) return new Error("DeepSeek API 请求过于频繁，请稍后再试。");
  if (status === 402) return new Error("DeepSeek 账户余额不足或未开通 API 服务。");
  return new Error(`DeepSeek 连接测试失败（HTTP ${status}）。`);
}

export async function testDeepSeekConnection(
  input: DeepSeekCredentialInput,
  fetchImpl: typeof fetch = fetch
): Promise<DeepSeekConnectionResult> {
  const apiKey = validateDeepSeekApiKey(input.apiKey);
  const apiBase = normalizeDeepSeekBase(input.apiBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`${apiBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw connectionError(response.status);
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(payload.data)
      ? payload.data
          .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
          .filter(Boolean)
          .slice(0, 100)
      : [];
    return { apiBase, models };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("DeepSeek 连接测试超时，请检查网络或 API 地址。");
    }
    if (error instanceof Error && /DeepSeek/.test(error.message)) throw error;
    throw new Error("无法连接 DeepSeek，请检查网络、API 地址和 Key。");
  } finally {
    clearTimeout(timer);
  }
}

export async function saveDeepSeekCredential(
  userId: string,
  input: DeepSeekCredentialInput,
  tested?: DeepSeekConnectionResult
) {
  const apiKey = validateDeepSeekApiKey(input.apiKey);
  const apiBase = normalizeDeepSeekBase(input.apiBase);
  const model = normalizeDeepSeekModel(input.model);
  const connection = tested ?? await testDeepSeekConnection({ apiKey, apiBase, model });
  return prisma.userProviderCredential.upsert({
    where: { userId_provider: { userId, provider: DEEPSEEK_PROVIDER } },
    create: {
      userId,
      provider: DEEPSEEK_PROVIDER,
      apiKeyCiphertext: encryptSecret(apiKey),
      apiKeyHint: maskApiKey(apiKey),
      apiBase: connection.apiBase,
      model,
      lastTestedAt: new Date(),
      lastError: null
    },
    update: {
      apiKeyCiphertext: encryptSecret(apiKey),
      apiKeyHint: maskApiKey(apiKey),
      apiBase: connection.apiBase,
      model,
      lastTestedAt: new Date(),
      lastError: null
    },
    select: { apiBase: true, model: true, apiKeyHint: true, lastTestedAt: true }
  });
}

export async function deleteDeepSeekCredential(userId: string): Promise<void> {
  await prisma.userProviderCredential.deleteMany({ where: { userId, provider: DEEPSEEK_PROVIDER } });
}

export async function getDeepSeekCredentialStatus(userId: string): Promise<DeepSeekCredentialStatus> {
  const credential = await prisma.userProviderCredential.findUnique({
    where: { userId_provider: { userId, provider: DEEPSEEK_PROVIDER } },
    select: { apiBase: true, model: true, apiKeyHint: true, apiKeyCiphertext: true, lastTestedAt: true, lastError: true }
  });
  if (!credential) {
    return {
      connected: false,
      apiBase: DEFAULT_DEEPSEEK_BASE,
      model: DEFAULT_DEEPSEEK_MODEL,
      keyHint: null,
      lastTestedAt: null,
      error: null
    };
  }
  let credentialError = credential.lastError;
  let connected = Boolean(credential.apiKeyHint && credential.lastTestedAt);
  try {
    decryptSecret(credential.apiKeyCiphertext);
  } catch (error) {
    connected = false;
    credentialError = error instanceof Error ? error.message : "API 凭证无法解密。";
  }
  return {
    connected,
    apiBase: credential.apiBase,
    model: credential.model,
    keyHint: credential.apiKeyHint,
    lastTestedAt: credential.lastTestedAt?.toISOString() ?? null,
    error: credentialError
  };
}

export async function getProjectDeepSeekCredential(projectId: string): Promise<ProjectDeepSeekCredential | null> {
  const admin = await prisma.projectRole.findFirst({
    where: { projectId, role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { providerCredentials: { where: { provider: DEEPSEEK_PROVIDER }, take: 1 } } } }
  });
  const credential = admin?.user.providerCredentials[0];
  if (!credential) return null;
  return {
    apiKey: decryptSecret(credential.apiKeyCiphertext),
    apiBase: normalizeDeepSeekBase(credential.apiBase),
    model: normalizeDeepSeekModel(credential.model)
  };
}

