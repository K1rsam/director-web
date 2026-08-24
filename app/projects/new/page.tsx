import Link from "next/link";
import { PROJECT_STYLE_OPTIONS } from "@/lib/project-entry";
import { ProjectCreateForm } from "./project-create-form";
import { AppChrome } from "@/app/ui/app-chrome";

export default function NewProjectPage() {
  return (
    <AppChrome
      title="创建剧本项目"
      eyebrow="新建项目"
      activeSection="new"
      primaryAction={<Link href="/" className="topbarPrimary">返回项目总览</Link>}
    >
      <section className="createProjectPage">
        <div className="createPageHeading">
          <p className="sectionEyebrow">NEW PROJECT</p>
          <h1>创建剧本项目</h1>
          <p>提供完整剧本并选择固定风格模板，系统将从全剧资料整理开始。</p>
        </div>
        <ProjectCreateForm styles={PROJECT_STYLE_OPTIONS} />
      </section>
    </AppChrome>
  );
}
