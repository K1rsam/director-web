# fidelity/3 契约

3008另支持 [FIDELITY-TEXT/1](external-text.md) 运输适配协议。用户发起原稿P1整理或导入外部结构结果即授权结构处理，适配器仅生成受限完整行决定，再交本校验器；该授权不包含改正文或确认制作问题。以下旧CLI要求独立传入受信决定仍适用，不直接信任任意plan内自带决定。

运行环境：Node 20+，无第三方依赖；唯一权威为 scripts/fidelity.mjs。网页必须导入该模块，下载包复制同一版本文件，不另写校验逻辑。

坐标是 JS UTF-16 的半开区间 `[start,end)`，不是 Unicode 码点或 UTF-8 字节。源文以完整行分段，CRLF、代理对与组合字符不会被行边界拆开；空格和换行均归入区间且不 trim 正文。UTF-8 无效字节 CLI 拒绝，不静默替换。

- `createSource(text)` → 冻结 `{text,sourceVersion,length,coordinateSystem:'utf16'}`。sourceVersion 为读取文本 UTF-8 SHA256；原文件字节 hash 为独立 `originalFile.sha256`。
- `proposePlan(source,{decisions?})` → `{contractVersion,sourceVersion,decisionVersion,decisions,segments,issues}`。
- `validatePlan(source,plan,{decisions?})` → `{ok,errors,issues,coverage:{length,covered}}`；受信决定必须由调用者独立提供，默认空数组。错误的 plan 自带决定不会被授权。
- `renderNormalized(source,plan,{decisions?})` → MD 字符串，包含新标题及逐字来源全文；不通过抛错并附 validation。
- `normalize(source,{plan?,decisions?})` → `{contractVersion,source,plan,validation,normalizedText,segments,episodes,contextText}`；source 也可直接传字符串。

`segments` 每行字段：`id,start,end,kind,episodeId,sceneId,sourceNumber,productionEligible,reason,speakerLabels`。kind 为 body/context/format；稳定 id 包含 sourceVersion 和原始位置。输出 segments 额外附 text、textHash，不得把这些输出字段复制进 plan。sourceNumber 为保留的源集号，场的源标题在 scene.sourceNumber 保留。display number 仅显示排序不改变身份。

episodes 和 scenes 含 `id,number,sourceNumber,title,start,end,content,productionEligible`；episode 还含 segments/scenes。正文无标题时仍在全局 segments，episodes 为空且 issue 可见，不假造第一集。资料与空白保留在全局来源链，生产消费者只选择生产集场，不得直接拿完整 normalizedText 当生产正文。选定内容以 segments 文本拼接为准，用户资料决定造成中间排除时 start/end 是包围范围而不是许可把该范围整体投入生产。

`decisions` 为完整行、不重叠的 `{start,end,kind:'body'|'context',note,episodeNumber?,sceneNumber?}` 数组；note 必填。正文可用非负整数 episodeNumber 指定集，正整数 sceneNumber 指定场；多个范围同episodeNumber归入同一用户决定集，稳定ID依据该集首个决定位置。decisionVersion 为规范化决定数组 SHA256，修改决定后必须重新 proposePlan。sourceVersion 未变化并不能授权旧页面覆盖新决定；网站应以 sourceVersion+decisionVersion+数据库 revision 原子比较保存。模型只产候选说明，用户采用后才是受信决定，本版不直接执行任意模型边界计划。

normalizedText 是显示视图，在每段确切源切片外生成 source-range 注释与集场标题，不能直接重导为旧原稿；回导用 JSON source+plan。source-range 的长度由 end-start 指定，正文自身可能包含同名注释，解析时不可仅按标记文本查找。网页展示原文必须转义 HTML，不能直接执行原文标签。

校验器固定重算全部行的来源绑定和说话者标签；拒绝未知字段、replacementText、自定义 speaker、遗漏/重复/错序/截断、删除疑点、过期决定。说话者标签只是一致性校验辅助，未知语法不推断身份。完整原行作为不可变单元，不能把张三原句挂在李四字段下。相同句子不同位置 ID 不同，背景同句不能抵消正文漏句。

数字点号对场头（1.1、1．1、1. 1）要求编号后明确分隔，并含日夜/内外等场景元数据；金额小数不据此拆场。横线标题也支持编号紧接中文地点且具有日夜/内外场景依据，价格和比分不能据此拆场。有集但正文未归明确场时保留疑点，界面按连续区间合并。用户可用episodeNumber+sceneNumber决定采用边界；同源集标题和场决定共享集身份，空格式集不占生产排序。说话者词法标签支持多人同一行，不保证语义身份推断。

v1回导包由网站使用保留的v1校验器先核验，再用v2重算结构；不能把旧计划直接冠以新版本。原上传、读取文本、已采用决定保持可追溯。ZIP入口只读取数据，不执行其中脚本；可自动发现回导JSON和配对原稿。DOCX配对可使用明确的每段单LF视图，只有全文逐字相等才通过，不删除或折叠任意正文空白。

DOCX 不由本 CLI 读取。网站提取时须保存读取器和版本，明确警告是否支持段落、表格、页眉页脚、文本框、脚注、修订、嵌入图片。提取后字符相等不能证明这些对象均被完整读取；在无法确认时保留原 DOCX，并将提取风险作为待处理项。此包只含合成示例，不含私人剧本、DB、环境配置。

## 场标题与诊断范围（fidelity/3）

程序识别有明确元数据的行首“场N-M”，以及集标题同行的同集场声明；源行仍按原坐标完整保留，同行人物、动作、台词属于正文。错集编号、对白中提及场号等不据此自动改归属。无法确认的边界仍保留，不能猜成整集一场。

同一连续正文范围只生成一项同类边界诊断；跨集、已确认场、资料和格式行不合并。旧 fidelity/1 与 fidelity/2 包由对应冻结校验器严格验真，再从原文和受信决定生成当前结构。不得忽略旧包字段或删掉疑点以凑通过。已有原稿检查的完成范围与付费返回不因普通刷新而重新请求；待本轮检查保存时升级派生结构。
