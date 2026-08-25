"use client";

import { useState } from "react";

type BibleFact = { fact: string; source_node_refs: string[] };
type BibleEpisode = {
  number: number;
  one_line_progress: string;
  start_state: string;
  end_state: string;
  key_changes: string[];
  source_node_refs: string[];
};
type BibleRelation = { a: string; b: string; stages: Array<{ episode_range: string; state: string; knowledge: string }> };
type BibleSecret = { secret: string; known_to: string[]; revealed_to_audience_at: string; revealed_to_character_at: string };
type BibleBoundary = { from_episode: number; to_episode: number; carry_over: string };

type Bible = {
  schema: string;
  story_contract?: {
    genre: string;
    perspective: string;
    core_desire: string;
    immutable_facts: BibleFact[];
  };
  episodes?: BibleEpisode[];
  relationships?: BibleRelation[];
  secrets?: BibleSecret[];
  foreshadowing?: Array<{ setup: string; payoff: string }>;
  boundaries?: BibleBoundary[];
};

export function ProjectBibleViewer({ content }: { content: string }) {
  const [rawOpen, setRawOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<Set<string>>(new Set(["contract", "episodes"]));

  let bible: Bible | null = null;
  let placeholder = false;
  try {
    const parsed = JSON.parse(content) as Bible;
    if (parsed && parsed.schema === "PROJECT_MEMORY_V2" && Array.isArray(parsed.episodes)) bible = parsed;
    else placeholder = true;
  } catch {
    placeholder = true;
  }

  if (placeholder || !bible) {
    return (
      <div className="biblePlaceholder">
        <p>当前「项目策划与全剧索引」还是导入时的占位数据。</p>
        <p>点击上方「重新整理第一阶段」，由 P1 全剧基础策划师生成结构化项目圣经（故事契约 / 逐集推进 / 关系 / 秘密 / 跨集边界）。</p>
      </div>
    );
  }

  const toggle = (key: string) => {
    setSectionOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isOpen = (key: string) => sectionOpen.has(key);

  return (
    <div className="bibleViewer">
      <section className="bibleSection">
        <button type="button" className="bibleSectionHead" onClick={() => toggle("contract")} aria-expanded={isOpen("contract")}>
          <span>故事契约</span>
          <em>{isOpen("contract") ? "−" : "+"}</em>
        </button>
        {isOpen("contract") ? (
          <div className="bibleBody">
            <div className="bibleKeyValue">
              <span>题材</span><b>{bible.story_contract?.genre || "—"}</b>
              <span>视角</span><b>{bible.story_contract?.perspective || "—"}</b>
              <span>核心欲望</span><b>{bible.story_contract?.core_desire || "—"}</b>
            </div>
            {(bible.story_contract?.immutable_facts ?? []).length ? (
              <ul className="bibleFactList">
                {(bible.story_contract?.immutable_facts ?? []).map((fact, index) => (
                  <li key={index}><b>不可变事实</b>{fact.fact}<small>@{fact.source_node_refs.join("、")}</small></li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="bibleSection">
        <button type="button" className="bibleSectionHead" onClick={() => toggle("episodes")} aria-expanded={isOpen("episodes")}>
          <span>逐集推进</span><b className="bibleCount">{bible.episodes?.length ?? 0}集</b>
          <em>{isOpen("episodes") ? "−" : "+"}</em>
        </button>
        {isOpen("episodes") ? (
          <div className="bibleBody">
            {(bible.episodes ?? []).map((episode) => (
              <article className="bibleEpisode" key={episode.number}>
                <div className="bibleEpisodeHead"><b>第{episode.number}集</b><span>{episode.one_line_progress}</span></div>
                <div className="bibleEpisodeStates">
                  <span>起：{episode.start_state}</span>
                  <span>止：{episode.end_state}</span>
                </div>
                {(episode.key_changes ?? []).length ? <small>关键变化：{episode.key_changes.join("、")}</small> : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {["relationships", "secrets", "foreshadowing", "boundaries"].map((key) => {
        const meta = {
          relationships: { title: "人物关系", count: bible.relationships?.length ?? 0 },
          secrets: { title: "秘密与知情", count: bible.secrets?.length ?? 0 },
          foreshadowing: { title: "伏笔与回收", count: bible.foreshadowing?.length ?? 0 },
          boundaries: { title: "跨集边界", count: bible.boundaries?.length ?? 0 }
        }[key as "relationships"];
        if (!meta.count) return null;
        return (
          <section className="bibleSection" key={key}>
            <button type="button" className="bibleSectionHead" onClick={() => toggle(key)} aria-expanded={isOpen(key)}>
              <span>{meta.title}</span><b className="bibleCount">{meta.count}</b>
              <em>{isOpen(key) ? "−" : "+"}</em>
            </button>
            {isOpen(key) ? (
              <div className="bibleBody">
                {key === "relationships" ? (bible.relationships ?? []).map((rel, index) => (
                  <article className="bibleLine" key={index}><b>{rel.a} ↔ {rel.b}</b>{rel.stages.map((stage, i) => (
                    <span key={i}>{stage.episode_range}｜{stage.state}{stage.knowledge ? `｜知情：${stage.knowledge}` : ""}</span>
                  ))}</article>
                )) : null}
                {key === "secrets" ? (bible.secrets ?? []).map((secret, index) => (
                  <article className="bibleLine" key={index}><b>{secret.secret}</b><span>知情：{secret.known_to.join("、")}</span><span>观众知：{secret.revealed_to_audience_at}｜角色知：{secret.revealed_to_character_at}</span></article>
                )) : null}
                {key === "foreshadowing" ? (bible.foreshadowing ?? []).map((item, index) => (
                  <article className="bibleLine" key={index}><b>伏笔：{item.setup}</b><span>回收：{item.payoff}</span></article>
                )) : null}
                {key === "boundaries" ? (bible.boundaries ?? []).map((item, index) => (
                  <article className="bibleLine" key={index}><b>第{item.from_episode}集 → 第{item.to_episode}集</b><span>{item.carry_over}</span></article>
                )) : null}
              </div>
            ) : null}
          </section>
        );
      })}

      <button type="button" className="bibleRawToggle" onClick={() => setRawOpen((value) => !value)}>
        {rawOpen ? "收起完整 JSON" : "查看完整 JSON"}
      </button>
      {rawOpen ? <pre className="bibleRawJson">{content}</pre> : null}
    </div>
  );
}
