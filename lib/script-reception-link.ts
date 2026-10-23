/** Only actual source-parser coordinates offer this free local review route. */
export function scriptReceptionIssueLink(projectId:string,coordinate:string){
 const match=/^source\.episodes\.(\d+)\.script\.L(\d+)$/u.exec(coordinate);
 if(!match)return null;
 const episode=Number(match[1]),line=Number(match[2]);
 return Number.isSafeInteger(episode)&&episode>=0&&Number.isSafeInteger(line)&&line>0?{episode,line,href:`/projects/${encodeURIComponent(projectId)}/preparation?episode=${episode}#script-line-${line}`}:null;
}
