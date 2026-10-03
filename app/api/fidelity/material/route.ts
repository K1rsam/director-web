import { requireSessionUser } from "@/lib/auth";
import { parseScriptBuffer } from "@/lib/import-script";
import { createFidelityExternalMaterial } from "@/lib/fidelity-external";
import {readLocalFormData,LocalRequestError} from '@/lib/local-json-request';

export const runtime = "nodejs";

export async function POST(request: Request) {
  await requireSessionUser();
  try {
    const data = await readLocalFormData(request,41*1024*1024);
    const paired = data.get("originalScript");
    const script = data.get("script");
    const file = paired instanceof File && paired.size ? paired : script;
    const bytes = file instanceof File && file.size
      ? Buffer.from(await file.arrayBuffer())
      : Buffer.from(String(data.get("scriptText") ?? ""), "utf8");
    if (!bytes.length) throw new Error("请先上传或粘贴原稿。");
    if (bytes.length > 20 * 1024 * 1024) throw new Error("原稿超过20MB。");
    const imported = await parseScriptBuffer(file instanceof File && file.size ? file.name : "original.txt", bytes);
    const material = createFidelityExternalMaterial(imported.sourceText);
    return Response.json({ text: material.text, sourceVersion: material.sourceVersion });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "生成外部整理材料失败" }, { status: error instanceof LocalRequestError?error.status:400 });
  }
}
