import assert from 'node:assert/strict';
import {collectPhysicalEvidenceIssues,hasAffirmativeAudioOnlyDeclaration} from '../lib/foundation-physical-evidence';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {requireProductionCatalogAuthor} from '../lib/foundation-production-contracts';
import {collectFoundationPublicationIssues} from '../lib/foundation-state';
const index=buildSourceIndex([1,2].map(number=>({number,title:null,content:`第${number}集\n${number}-1 日 外 广场\n△守卫接过铜钥匙。\n`} )));
const catalogue=requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:[1,2],assets:[{name:'守卫',type:'CH',episodes:[1,2],preparation:{mode:'REFERENCE'}}]},index,[1,2]);
const base=catalogue.assets[0], original=structuredClone(base);
const issues=(note:string,mode:'REFERENCE'|'AUDIO'|'UNRESOLVED'='REFERENCE')=>collectPhysicalEvidenceIssues([{...base,preparation:{mode,note}}],index);
for(const note of [
 '1-1为铜钥匙交接的接收者，2-1亲手交还钥匙，需实体形象；VO标签保留，不据此降为纯声音。',
 '并非纯声音，需实体形象。','不是只有声音。','不能判定为纯声音。','不应认定只有声音。','避免误判仅声音。',
 '不能不安排实体入镜。','并非没有实体出场。','不得仅使用VO。','尚未确定是否仅声音。',
 '本批声音出现不撤销其它集的可视备图基线；仅完整适用范围核对后可改为纯声音。',
 '如果采用纯声音，需要另行确认。','“纯声音”是被否定的方案。','not audio-only; retain physical reference',
 ]){assert.equal(hasAffirmativeAudioOnlyDeclaration(note),false,note);assert.equal(issues(note).length,0,note);}
for(const note of ['本次不安排实体入镜。','纯声音。','本集仅使用VO。','只有声音，无实体入镜。','voice-only','不能判定其它情况，但本次仅声音。']){
 assert.equal(hasAffirmativeAudioOnlyDeclaration(note),true,note);assert.equal(issues(note).length,2,note);
}
assert.equal(issues('需实体形象；不据此降为纯声音。','AUDIO').length,2,'explicit AUDIO still conflicts with physical evidence regardless of prose');
assert.equal(issues('纯声音待核','UNRESOLVED').length,0,'unresolved production status is not an asserted exclusion');
assert.deepEqual(issues('第一集为VO，本次不安排实体入镜；第二集需实体形象。').map(issue=>issue.sourceRefs[0].episode),[1],'explicit episode scope stays local');
assert.deepEqual(base,original);assert.ok(issues('纯声音')[0].problem.includes('明确实体交互'));
const stale={...catalogue,issues:issues('纯声音')};
assert.equal(collectFoundationPublicationIssues(stale,undefined,index).filter(i=>i.problem.includes('明确实体交互')).length,0,'obsolete derived issues must not force AI to rewrite correct current assets');
assert.equal(stale.issues.length,2,'historical evidence remains unchanged');
console.log('PASS affirmative audio-only declarations and AUDIO conflicts; negated/conditional/quoted audio mentions do not override physical preparation; source/episode scope preserved');
