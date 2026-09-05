"use client";

import { useActionState, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { importProjectAction, type ProjectCreationState } from "@/app/actions";
import type { ProjectStyleOption, ProjectSubmissionMode } from "@/lib/project-entry";

const initialState: ProjectCreationState = { error: "" };

export function ProjectCreateForm({ styles }: { styles: ProjectStyleOption[] }) {
  const [state, formAction, pending] = useActionState(importProjectAction, initialState);
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
    <form action={formAction} className="createProjectForm" onSubmit={(event) => {
      if (pending || submitting.current) event.preventDefault();
      else submitting.current = true;
    }}>
      <input name="mode" type="hidden" value={mode} />

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
              <em>TXT · MD · DOCX</em>
              <input
                id="script-upload"
                name="script"
                type="file"
                accept=".txt,.md,.docx"
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
              ? "创建后自动进入全剧资料整理；API（DeepSeek）使用与 CLI 同一套 E0–E5 岗位 Skill。"
              : "创建后自动进入全剧资料整理；CLI 模式使用本机 Codex 执行 E0–E5 岗位。"}
          </p>
        </div>
        <button className="studioButton primaryAction createSubmit" data-variant="primary" type="submit" disabled={pending} aria-busy={pending}>
          {pending ? "正在创建项目…" : "创建项目并开始解析"}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
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
