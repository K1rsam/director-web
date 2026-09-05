import type { ReactNode } from "react";

type PromptDocumentProps = { content: string };

// These are display markers, not a second prompt compiler. Every matched group,
// unknown line, space and original line ending is rendered without rewriting.
const sectionNames = "通用提示词|场景|本单元道具|本单元出场人物|本单元光影|人物状态与站位前提";
const sectionTitle = new RegExp(`^([ \\t]*[\\[【])(${sectionNames})([\\]】][ \\t]*)$`, "u");
const contextField = new RegExp(`^([ \\t]*[\\[【])(${sectionNames})([ \\t]*[:：][ \\t]*)(.*)([\\]】][ \\t]*)$`, "u");
const shotHeading = /^([ \t]*(?:[-*][ \t]+)?)(分镜[ \t]*\d+|镜头[ \t]*\d+)(?!\d)([ \t,，、:：|｜（(].*|)$/u;
const shotField = /^([ \t]*(?:[-*][ \t]+)?)(机位\/运动|机位／运动|机位|运动|画面|光影|声音|台词|文本|转场节拍|转场)([ \t]*[:：][ \t]*)(.*)$/u;

function displayLine(text: string, ending: string, key: number): ReactNode {
  if (/^[ \t]*$/u.test(text)) {
    return <span className="promptDocumentSpace" aria-hidden="true" key={key}>{text}{ending}</span>;
  }

  const heading = text.match(/^([ \t]*#{1,6}[ \t]+)(.*)$/u);
  if (heading) {
    return <h4 className="promptDocumentTitle" key={key}><span className="promptDocumentSyntax">{heading[1]}</span>{heading[2]}{ending}</h4>;
  }

  const section = text.match(sectionTitle);
  if (section) {
    return <h5 className="promptDocumentSectionTitle" key={key}><span className="promptDocumentSyntax">{section[1]}</span>{section[2]}<span className="promptDocumentSyntax">{section[3]}</span>{ending}</h5>;
  }

  const context = text.match(contextField);
  if (context) {
    return <div className="promptDocumentField promptDocumentContext" key={key}><span className="promptDocumentLabel"><span className="promptDocumentSyntax">{context[1]}</span>{context[2]}{context[3]}</span><span>{context[4]}<span className="promptDocumentSyntax">{context[5]}</span>{ending}</span></div>;
  }

  const shot = text.match(shotHeading);
  if (shot) {
    return <h5 className="promptDocumentShot" key={key}><span className="promptDocumentSyntax">{shot[1]}</span><span className="promptDocumentShotNumber">{shot[2]}</span><span className="promptDocumentShotTiming">{shot[3]}</span>{ending}</h5>;
  }

  const field = text.match(shotField);
  if (field) {
    return <div className="promptDocumentField" key={key}><span className="promptDocumentLabel"><span className="promptDocumentSyntax">{field[1]}</span>{field[2]}{field[3]}</span><span>{field[4]}{ending}</span></div>;
  }

  return <p className="promptDocumentLine" key={key}>{text}{ending}</p>;
}

/** Pure presentation: callers keep the original string for copying/editing. */
export function PromptDocument({ content }: PromptDocumentProps) {
  const parts = content.split(/(\r\n|\n|\r)/u);
  const lines: ReactNode[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index];
    const ending = parts[index + 1] ?? "";
    if (text || ending) lines.push(displayLine(text, ending, index));
  }
  return <div className="promptDocument">{lines}</div>;
}
