import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_KEY_LENGTH = 512;

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "请先登录网站。" }, { status: 401 });

  const apiKey = await readApiKey(request);
  if (!apiKey) return Response.json({ error: "请输入有效的 DeepSeek API Key。" }, { status: 400 });

  try {
    const response = await fetch("https://api.deepseek.com/models", {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return Response.json(
        { error: deepSeekError(response.status) },
        { status: response.status === 401 || response.status === 402 || response.status === 429 ? response.status : 502 },
      );
    }

    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(payload.data)
      ? payload.data.map((item) => item.id).filter((id): id is string => typeof id === "string")
      : [];
    return Response.json(
      { ok: true, models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "DeepSeek 连接超时，请稍后重试。"
      : "暂时无法连接 DeepSeek，请检查网络后重试。";
    return Response.json({ error: message }, { status: 502 });
  }
}

async function readApiKey(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string") return null;
    const value = body.apiKey.trim();
    if (value.length < 8 || value.length > MAX_KEY_LENGTH || /\s/.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function deepSeekError(status: number): string {
  if (status === 401) return "API Key 无效，请重新复制。";
  if (status === 402) return "DeepSeek 账户余额不足。";
  if (status === 429) return "DeepSeek 请求过于频繁，请稍后重试。";
  return "DeepSeek 暂时不可用，请稍后重试。";
}
