"use client";

import { ImportIssueSummary } from "@/app/ui/import-issue-summary";
import { useActionState, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { importProjectAction, type ProjectCreationState } from "@/app/actions";
import type { ProjectStyleOption, ProjectSubmissionMode } from "@/lib/project-entry";

const initialState: ProjectCreationState = { error: "" };

export function ProjectCreateForm({ styles }: { styles: ProjectStyleOption[] }) {
  const [state, formAction, pending] = useActionState(importProjectAction, initialState);
  const [preview,setPreview] = useState<{effectiveMode?:"fidelity"|"direct";sourceVersion:string;originalHash:string;episodes:{number:number;title:string;length:number}[];contextLength:number;productionEpisodeCount?:number;candidateEpisodeCount?:number;sceneCount?:number;issueCount?:number;issues:{code:string;message:string;start?:number;end?:number;count?:number;sectionKeys?:string[]}[];warnings:string[];guarantee:string;preview:string;previewTruncated:boolean}|null>(null);
  const [previewBusy,setPreviewBusy]=useState(false);const [previewError,setPreviewError]=useState("");
  const [cleaningMode,setCleaningMode]=useState("fidelity");
  const [externalMaterial, setExternalMaterial] = useState("");
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialMessage, setMaterialMessage] = useState("");
  const submitting = useRef(false);
  useEffect(() => { submitting.current = pending; }, [pending]);
  const [mode, setMode] = useState<ProjectSubmissionMode>("upload");
  const [executionMode, setExecutionMode] = useState<"CLI" | "API">("CLI");
  const [fileName, setFileName] = useState("");
  const sourceTabRefs = useRef<Record<ProjectSubmissionMode, HTMLButtonElement | null>>({ upload: null, paste: null });
  const recommended = styles.filter((style) => style.recommended);
  const moreStyles = styles.filter((style) => !style.recommended);

  function handleSourceTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextMode: ProjectSubmissionMode;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        nextMode = mode === "upload" ? "paste" : "upload";
        break;
      case "Home":
        nextMode = "upload";
        break;
      case "End":
        nextMode = "paste";
        break;
      default:
        return;
    }
    event.preventDefault();
    setMode(nextMode);
    sourceTabRefs.current[nextMode]?.focus();
  }

  return (
    <form action={formAction} className="createProjectForm" onChange={event => {setPreview(null); const target = event.target; if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && ["script", "scriptText", "originalScript"].includes(target.name)) {setExternalMaterial("");setMaterialMessage("");}}} onSubmit={async (event) => {
      if (!preview) { event.preventDefault();if(previewBusy)return;setPreviewBusy(true);setPreviewError("");try{const response=await fetch("/api/fidelity/preview",{method:"POST",body:new FormData(event.currentTarget)});const result=await response.json();if(!response.ok)throw new Error(result.error);setPreview(result);}catch(error){setPreviewError(error instanceof Error?error.message:"预览失败");}finally{setPreviewBusy(false);}return; }
      if (pending || submitting.current) event.preventDefault();
      else submitting.current = true;
    }}>
      <input name="mode" type="hidden" value={mode} />
      <input type="hidden" name="previewSourceVersion" value={preview?.sourceVersion??""}/><input type="hidden" name="previewOriginalHash" value={preview?.originalHash??""}/>
      <section className="createFormSection"><h2>P1 · 接收与清洗</h2><p>{cleaningMode === "fidelity" ? "先保存原稿并做程序初检。创建后点击“整理资料”，P1 将调用 AI 检查全文结构；CLI 使用 GPT6-low。剧情、动作和台词保持原文，只整理集场与资料归属。" : "导入外部整理成果，由程序解析并校验，不再次调用 AI 清洗全文。配对原稿后可以检查是否改字、漏段或重复。"}</p>
      <label>处理方式 <select name="cleaningMode" value={cleaningMode} onChange={event=>setCleaningMode(event.target.value)}><option value="fidelity">原稿：AI 检查结构，保留正文</option><option value="direct">已清洗：程序校验并直接导入</option></select></label>
      <p>可粘贴外部 AI 的回复，或上传 TXT、MD、DOCX；也兼容 JSON 和 ZIP。旧 DOC 请先另存为 DOCX。</p>
      {cleaningMode === "direct" ? <label>配对原稿（建议提供）<input type="file" name="originalScript" accept=".txt,.md,.docx" /></label> : null}
      {cleaningMode === "direct" ? <p>没有配对原稿时，仅以本次上传稿为基准，不能证明外部 AI 没有改写原文。</p> : null}
      <details><summary>让其他 AI 整理：复制材料与接收回复</summary><p>先上传原稿，再生成带原文编号的材料交给其他 AI。AI 只返回归属标记；正文由本系统从原稿复制。收到回复后选择“已清洗”，粘贴回复并配对同一原稿。</p>
      <button type="button" disabled={materialBusy} onClick={async event => { const form=event.currentTarget.form;if(!form)return;setMaterialBusy(true);setMaterialMessage("");try {const response=await fetch("/api/fidelity/material",{method:"POST",body:new FormData(form)});const result=await response.json();if(!response.ok)throw new Error(result.error);setExternalMaterial(result.text);}catch(error){setMaterialMessage(error instanceof Error?error.message:"生成失败");}finally{setMaterialBusy(false);} }}>{materialBusy ? "正在准备…" : "生成外部整理材料"}</button>
      {externalMaterial ? <><textarea aria-label="发给外部 AI 的完整材料" readOnly value={externalMaterial} rows={8}/><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(externalMaterial);setMaterialMessage("已复制完整材料。");}catch{setMaterialMessage("请在上方文本框全选复制。");}}}>复制完整材料</button></> : null}
      {materialMessage ? <p role="status">{materialMessage}</p> : null}
      <p><a href="/api/fidelity/skill?format=md">查看外部整理说明</a> · <a href="/api/fidelity/skill">下载 Skill 与示例</a></p></details>
      <details><summary>旧结构包的边界决定</summary><label><input type="checkbox" name="trustExternalDecisions" value="1" />采用旧 JSON 结构包中已经核对的集场和资料归属</label></details></section>

      <section className="createFormSection scriptSourceSection" aria-labelledby="script-source-title">
        <div className="formSectionHeader">
          <span aria-hidden="true">01</span>
          <div>
            <h2 id="script-source-title">提供剧本</h2>
            <p id="script-source-help">支持 TXT、MD、DOCX；建议直接导入已经规范化的完整剧本。</p>
          </div>
        </div>

        <div className="sourceTabs" role="tablist" aria-label="剧本输入方式">
          <button
            type="button"
            role="tab"
            id="script-upload-tab"
            aria-controls="script-upload-panel"
            aria-selected={mode === "upload"}
            tabIndex={mode === "upload" ? 0 : -1}
            ref={(element) => { sourceTabRefs.current.upload = element; }}
            onKeyDown={handleSourceTabKeyDown}
            className={mode === "upload" ? "active" : ""}
            onClick={() => setMode("upload")}
          >
            上传剧本
          </button>
          <button
            type="button"
            role="tab"
            id="script-paste-tab"
            aria-controls="script-paste-panel"
            aria-selected={mode === "paste"}
            tabIndex={mode === "paste" ? 0 : -1}
            ref={(element) => { sourceTabRefs.current.paste = element; }}
            onKeyDown={handleSourceTabKeyDown}
            className={mode === "paste" ? "active" : ""}
            onClick={() => setMode("paste")}
          >
            粘贴文本
          </button>
        </div>

        <div id="script-upload-panel" role="tabpanel" aria-labelledby="script-upload-tab" hidden={mode !== "upload"}>
          {mode === "upload" ? (
            <label className="scriptDropzone" htmlFor="script-upload">
              <span className="uploadIcon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" /></svg>
              </span>
              <strong role="status">{fileName || "选择剧本文件"}</strong>
              <small>{fileName ? "点击可重新选择" : "或将文件拖入此处"}</small>
              <em>TXT · MD · DOCX · ZIP</em>
              <input
                id="script-upload"
                name="script"
                type="file"
                accept=".txt,.md,.docx,.json,.zip"
                aria-label="选择剧本文件"
                aria-describedby="script-source-help"
                required
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
              />
            </label>
          ) : null}
        </div>
        <div id="script-paste-panel" role="tabpanel" aria-labelledby="script-paste-tab" hidden={mode !== "paste"}>
          {mode === "paste" ? (
            <label className="scriptPasteField">
              <span>剧本正文</span>
              <textarea
                name="scriptText"
                aria-describedby="script-source-help"
                required
                placeholder="在此粘贴完整剧本。系统只读取你提供的内容，不会在导入阶段改写正文。"
              />
            </label>
          ) : null}
        </div>
      </section>

      <section className="createFormSection projectConfigSection" aria-labelledby="project-config-title">
        <div className="formSectionHeader">
          <span aria-hidden="true">02</span>
          <div>
            <h2 id="project-config-title">项目配置</h2>
            <p id="project-style-help">风格模板会在最终编译时自动加入每个独立 Seedance 分镜单元。</p>
          </div>
        </div>

        <div className="basicConfigGrid">
          <label>
            <span>项目名称</span>
            <input name="title" type="text" maxLength={50} placeholder="输入剧名或项目名" required />
          </label>
          <label>
            <span>画面比例</span>
            <select name="aspectRatio" defaultValue="16:9">
              <option value="16:9">16:9（默认）</option>
              <option value="9:16">9:16</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="1:1">1:1</option>
            </select>
          </label>
        </div>

        <fieldset className="styleFieldset" aria-describedby="project-style-help">
          <legend>画面风格</legend>
          <p>推荐风格</p>
          <div className="styleOptionGrid recommendedStyles">
            {recommended.map((style, index) => (
              <StyleOption key={style.id} style={style} defaultChecked={index === 0} />
            ))}
          </div>
          <p>更多风格</p>
          <div className="styleOptionGrid moreStyles">
            {moreStyles.map((style) => <StyleOption key={style.id} style={style} />)}
          </div>
        </fieldset>
      </section>

      {previewError?<p role="alert">{previewError}</p>:null}
      {preview ? <section className="createFormSection" aria-label="导入预览">
        <h2>程序初检完成 · 请确认导入</h2><p>{preview.guarantee}</p>
        <p>{preview.productionEpisodeCount ?? preview.episodes.length} 个可导入正文集；作者资料 {preview.contextLength} 字符。结构提示 {preview.issueCount ?? preview.issues.reduce((sum, issue) => sum + (issue.count ?? 1), 0)} 处，已按类型合并。</p>
        {preview.candidateEpisodeCount && preview.candidateEpisodeCount !== (preview.productionEpisodeCount ?? preview.episodes.length) ? <p>另有候选范围尚待归类，不计入正文集数。</p> : null}
        {preview.warnings.length ? <details><summary>文件读取提示（{preview.warnings.length}）</summary>{[...new Set(preview.warnings)].map(w=><p key={w}>{w}</p>)}</details> : null}
        <ImportIssueSummary issues={preview.issues}/>
        <details><summary>查看分集列表</summary><ul style={{maxHeight:240,overflow:"auto"}}>{preview.episodes.map((e,i)=><li key={i}>{e.title} · {e.length} 字符</li>)}</ul></details>
        <details><summary>查看清洗视图{preview.previewTruncated?"（预览前12000字符，完整内容已保留）":""}</summary><pre style={{whiteSpace:"pre-wrap",maxHeight:320,overflow:"auto"}}>{preview.preview}</pre></details>
        <p>{(preview.effectiveMode ?? cleaningMode) === "fidelity" ? "本页为程序初检，尚未调用 AI。创建后点击“整理资料”，从 P1 的全文结构检查开始；检查记录和整理前后视图在“来源与清洗”中查看。" : "本页已完成程序解析与校验。后续从已接收成果继续，不重复全文 AI 清洗。"}</p>
      </section> : null}
      {!pending && state.error ? <div className="formError" role="alert">{state.error}</div> : null}

      <footer className="createFormFooter">
        <div className="createFooterInfo">
          <label className="executionModeFooter">
            <span>执行方式</span>
            <select
              name="executionMode"
              aria-describedby="execution-mode-help"
              value={executionMode}
              onChange={(event) => setExecutionMode(event.target.value === "API" ? "API" : "CLI")}
            >
              <option value="CLI">CLI（本机 Codex）</option>
              <option value="API">API（DeepSeek）</option>
            </select>
          </label>
          <p id="execution-mode-help">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></svg>
            {executionMode === "API"
              ? "创建后进入资料工作台；仅在点击整理资料后调用已连接的服务。"
              : "创建后进入资料工作台；仅在点击整理资料后使用本机 Codex。"}
          </p>
        </div>
        <button className="studioButton primaryAction createSubmit" data-variant="primary" type="submit" disabled={pending || previewBusy} aria-busy={pending}>
          {pending ? "正在创建项目…" : previewBusy ? "正在校验…" : preview ? "确认预览并创建项目" : "预览与校验剧本"}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
        </button>
      </footer>
    </form>
  );
}

function StyleOption({
  style,
  defaultChecked = false
}: {
  style: ProjectStyleOption;
  defaultChecked?: boolean;
}) {
  const optionId = useId();
  return (
    <label className="styleOption">
      <input name="styleId" type="radio" value={style.id} defaultChecked={defaultChecked} aria-labelledby={`${optionId}-label`} aria-describedby={`${optionId}-description`} />
      <span
        className="stylePreview"
        style={{ "--style-cover": `url("${style.coverImage}")` } as CSSProperties}
        aria-hidden="true"
      >
        <b>{style.category}</b>
      </span>
      <span className="styleOptionCopy">
        <strong id={`${optionId}-label`}>{style.label}</strong>
        <small id={`${optionId}-description`}>{style.description}</small>
      </span>
      <em aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="m5 12 4 4L19 6" /></svg></em>
    </label>
  );
}
