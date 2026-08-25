"use client";

import { useActionState, useState, type CSSProperties } from "react";
import { importProjectAction, type ProjectCreationState } from "@/app/actions";
import type { ProjectStyleOption, ProjectSubmissionMode } from "@/lib/project-entry";

const initialState: ProjectCreationState = { error: "" };

export function ProjectCreateForm({ styles }: { styles: ProjectStyleOption[] }) {
  const [state, formAction, pending] = useActionState(importProjectAction, initialState);
  const [mode, setMode] = useState<ProjectSubmissionMode>("upload");
  const [executionMode, setExecutionMode] = useState<"CLI" | "API">("CLI");
  const [fileName, setFileName] = useState("");
  const recommended = styles.filter((style) => style.recommended);
  const moreStyles = styles.filter((style) => !style.recommended);

  return (
    <form action={formAction} className="createProjectForm">
      <input name="mode" type="hidden" value={mode} />

      <section className="createFormSection scriptSourceSection">
        <div className="formSectionHeader">
          <span>01</span>
          <div>
            <h2>提供剧本</h2>
            <p>支持 TXT、MD、DOCX；建议直接导入已经规范化的完整剧本。</p>
          </div>
        </div>

        <div className="sourceTabs" role="tablist" aria-label="剧本输入方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "upload"}
            className={mode === "upload" ? "active" : ""}
            onClick={() => setMode("upload")}
          >
            上传剧本
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "paste"}
            className={mode === "paste" ? "active" : ""}
            onClick={() => setMode("paste")}
          >
            粘贴文本
          </button>
        </div>

        {mode === "upload" ? (
          <label className="scriptDropzone" htmlFor="script-upload">
            <span className="uploadIcon" aria-hidden="true">↑</span>
            <strong>{fileName || "选择剧本文件"}</strong>
            <small>{fileName ? "点击可重新选择" : "或将文件拖入此处"}</small>
            <em>TXT · MD · DOCX</em>
            <input
              id="script-upload"
              name="script"
              type="file"
              accept=".txt,.md,.docx"
              required
              onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
            />
          </label>
        ) : (
          <label className="scriptPasteField">
            <span>剧本正文</span>
            <textarea
              name="scriptText"
              required
              placeholder="在此粘贴完整剧本。系统只读取你提供的内容，不会在导入阶段改写正文。"
            />
          </label>
        )}
      </section>

      <section className="createFormSection projectConfigSection">
        <div className="formSectionHeader">
          <span>02</span>
          <div>
            <h2>项目配置</h2>
            <p>风格模板会在最终编译时自动加入每个独立 Seedance 分镜单元。</p>
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

        <fieldset className="styleFieldset">
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

      {state.error ? <div className="formError" role="alert">{state.error}</div> : null}

      <footer className="createFormFooter">
        <div className="createFooterInfo">
          <label className="executionModeFooter">
            <span>执行方式</span>
            <select
              name="executionMode"
              value={executionMode}
              onChange={(event) => setExecutionMode(event.target.value === "API" ? "API" : "CLI")}
            >
              <option value="CLI">CLI（本机 Codex）</option>
              <option value="API">API（DeepSeek）</option>
            </select>
          </label>
          <p>
            <span aria-hidden="true">●</span>
            {executionMode === "API"
              ? "创建后自动进入全剧资料整理；API（DeepSeek）使用与 CLI 同一套 E0–E5 岗位 Skill。"
              : "创建后自动进入全剧资料整理；CLI 模式使用本机 Codex 执行 E0–E5 岗位。"}
          </p>
        </div>
        <button className="primaryAction createSubmit" type="submit" disabled={pending}>
          {pending ? "正在创建项目…" : "创建项目并开始解析"}<span aria-hidden="true">→</span>
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
  return (
    <label className="styleOption">
      <input name="styleId" type="radio" value={style.id} defaultChecked={defaultChecked} />
      <span
        className="stylePreview"
        style={{ "--style-cover": `url("${style.coverImage}")` } as CSSProperties}
        aria-hidden="true"
      >
        <b>{style.category}</b>
      </span>
      <span className="styleOptionCopy">
        <strong>{style.label}</strong>
        <small>{style.description}</small>
      </span>
      <em aria-hidden="true">✓</em>
    </label>
  );
}
