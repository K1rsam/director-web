import type {PromptAsset} from './asset-prompt-contract';
export type AssetReferenceImage={id:string;name:string;mime:string;size:number;width:number;height:number};
export const IMAGE_QUALITIES=['1K','2K','4K'] as const;
export const IMAGE_RATIOS=['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9','9:21','1:3','3:1','2:1','1:2'] as const;
export type AssetImageOptions={revision:number;templateId:string;templateText:string;references:AssetReferenceImage[];count?:number;quality?:typeof IMAGE_QUALITIES[number];aspectRatio?:typeof IMAGE_RATIOS[number]};
export const IMAGE_TEMPLATES=[
 {id:'none',label:'无',types:['CH','GROUP','BEAST','LOC','PROP'],text:''},
 {id:'character-three-view',label:'人物三视图',types:['CH','GROUP','BEAST'],text:'本图采用同一角色的全身三视图排版：正面、侧面、背面。各视图中的脸部身份、发型、身体比例、服装、配饰与颜色保持一致，完整展示头顶至脚底，简洁纯色背景。以本段多视图构图替代前文的单视图构图。'},
 {id:'character-three-view-face',label:'主视图＋三视图（含脸部特写）',types:['CH','GROUP','BEAST'],text:'生成同一角色的设定图：左侧三分之一展示高细节正面脸部及上半身主视图，右侧三分之二并排展示全身正面、45度侧面、背面三视图。稳定保持同一身份、发型、体态、服装材质和配色，完整保留各全身图的头脚，简洁纯色背景。以本段多视图布局替代前文的单视图构图。'},
 {id:'character-front-back-face',label:'前后视图＋脸部特写',types:['CH','GROUP','BEAST'],text:'生成同一角色的设定图，左侧为清晰的正面脸部特写，右侧为完整的正面和背面全身图。脸部身份、发型、身材、服装与穿戴细节一致，头脚不裁切，简洁纯色背景。以本段三块设定图排版替代前文的单视图构图。'},
 {id:'character-analysis',label:'人设解析图',types:['CH','GROUP','BEAST'],text:'生成同一角色的人设解析图，包含完整正面、侧面、背面视图，面部特征特写，以及服装材质、鞋履与穿戴细节的局部展示。各区域保持身份与设计一致，排版紧凑清晰，简洁背景。以本段解析图布局替代前文的单视图构图。'},
 {id:'scene-four-view',label:'场景四视图',types:['LOC'],text:'生成同一物理空间的2×2四宫格设定图，依次为正面全景、反向全景、左侧全景、右侧全景。只改变观察方向，建筑、出入口、地标、陈设、尺度、材质、光源和状态保持一致；默认无人，不镜像或重新摆放空间。以本段四视图布局替代前文的单视图构图。'},
 {id:'scene-nine-view',label:'场景九视图',types:['LOC'],text:'生成同一连续空间的3×3九宫格场景设定图。依次为正面、左前45度、右前45度、左侧、右侧、后方、入口、高空45度俯视、正交俯视平面布局图。前八格只改变摄影机位置，空间比例、门窗、建筑、家具、物体数量、材质、颜色、天气和光源方向保持一致；第九格准确对应前八格布局。参考图未展示的区域只作最小补全；默认无人，不镜像或移动地标。以本段九视图布局替代前文的单视图构图。'}
];
export function emptyImageOptions():AssetImageOptions{return{revision:0,templateId:'none',templateText:'',references:[],count:1,quality:'1K',aspectRatio:'16:9'};}
export function imageTemplatesFor(type:PromptAsset['type']){return IMAGE_TEMPLATES.filter(t=>t.types.includes(type));}
export function compileImagePrompt(prefix:string,body:string,options:Pick<AssetImageOptions,'templateId'|'templateText'>){
 if(!body.trim())return '';
 return [prefix.trim(),body.trim(),options.templateId==='none'?'':options.templateText.trim()].filter(Boolean).join('\n\n');
}
