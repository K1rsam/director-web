import {fail} from './shared.mjs';

export const GENERATION_TEXT_VERSION='voice-delivery-v1';
export const GENERATION_TEXT_HINT='dialogueParts.text只写冻结source.dialogue.quote的连续原片段，含原标点、引号；说者、声道、声型不变，不把cue/performanceCues当原话或自动复制。delivery由当前声画设计提炼真正影响本句发声的气息、重音、速度、音高，picture/sound承接必要身体与声事件；不是把cue换同义词，也不凭非空字段自证表演正确。源cue和performanceCues完整保留作内部依据。每镜另写postproductionNotes:[{text,sourceRefs}]，没有则[]；text把已获准的人名/身份条及指定后期编辑叠字的准确文字、位置/占幅、样式和入驻退触发写全，sourceRefs只指本次制作源。它们只导出独立postproduction-notes.md，不进入unitDirection、单元/分段头、初末态或六栏，连“后期加XXX/不生成人名条”占位也不写。source.onscreenTexts是保真目录，不是逐项上屏指令；未确认的编辑叠字不执行，不改旁白。场内牌匾/信件/系统面板、确获准由生成承担的时间卡/其它叠字/幻想字形，以及原话本来提到后期或人名条，分别按源、采用决定和知情时点保留。程序只检查结构与源坐标，不代替语义分类、许可或内容审阅。';

export function assertGenerationTextVersion(version){
 if(version!==undefined&&version!==GENERATION_TEXT_VERSION)fail('RULE_SNAPSHOT','未知对白与后期隔离版本，保留原请求');
}

export function validatePostproductionNotes(draft,source){
 const refs=new Set((source?.sourceRows||[]).map(r=>r.id)),errors=[];
 for(const unit of Array.isArray(draft?.units)?draft.units:[])for(const shot of Array.isArray(unit?.shots)?unit.shots:[]){
  if(shot?.postproductionNotes===undefined)continue;
  const notes=shot.postproductionNotes;
  if(!Array.isArray(notes)||notes.some(note=>!note||typeof note.text!=='string'||!note.text.trim()||!Array.isArray(note.sourceRefs)||!note.sourceRefs.length||new Set(note.sourceRefs).size!==note.sourceRefs.length||note.sourceRefs.some(ref=>!refs.has(ref))))
   errors.push({code:'POSTPRODUCTION_NOTES',coordinate:shot?.id||unit?.id||'shot',detail:'后期说明须有完整文字及有效制作源坐标；结构有效不代表类别、许可或内容已通过。'});
 }
 return errors;
}

export function renderPostproductionNotes({draft,source,generationTextVersion}={}){
 assertGenerationTextVersion(generationTextVersion);
 if(generationTextVersion!==GENERATION_TEXT_VERSION)return '';
 const errors=validatePostproductionNotes(draft,source);if(errors.length)fail('POSTPRODUCTION_NOTES',errors[0].detail);
 const rows=[];
 for(const unit of draft?.units||[])for(const shot of unit.shots||[])for(const note of shot.postproductionNotes||[])
  rows.push(`## ${unit.id} / ${shot.id}\n\n源坐标：${note.sourceRefs.join('、')}\n\n${note.text}`);
 return rows.length?'# 后期编辑说明\n\n独立编辑资料，不复制到生成提示词。类别、采用许可、准确文字与揭示时点仍须按源及实际决定审阅；本文件不是自动批准或用户验收。\n\n'+rows.join('\n\n')+'\n':'';
}
