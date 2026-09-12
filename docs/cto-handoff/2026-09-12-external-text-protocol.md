# 外部结构文本导入实施验收

实施范围：3008外部结构协议、配对读取、Python适配及Skill；未改3000、生产数据库和用户原稿。

## 可运行接口

- `lib/fidelity-external.ts` 的 `createFidelityExternalMaterial(sourceText)` 返回来源版本、完整行短块ID、UTF16位置和可复制AI材料。支持LF/CRLF/CR，Unicode代理对位置由原文字符串保留。
- `parseFidelityExternalResult(sourceText,responseText)` 调用仓库固定Python适配器，返回声明式行范围及候选元数据。唯一Node fidelity/2继续验证和物化正文。
- `prepareFidelityImport` 现支持TXT/MD/DOCX中的FIDELITY-TEXT/1与FIDELITY-DRAFT/1；必须配原稿，保留原件字节、读取视图、版本。旧JSON/ZIP入口保留。
- receipt增加externalReview元数据；p1Review检查点类型由内部P1消费者使用。本子任务不启动AI或任务。

## 验证

`node --env-file=.env --import tsx scripts/verify-fidelity-external.ts`通过：三种文件容器，完整稿配对、Unicode、原文同名协议标记、正文/说话人改字拒绝、漏段/重复/错序/旧版本/漏尾拒绝，无原稿保证措辞，未知场界保留，短块CR读取，CRLF/CR完整稿三格式配对；实际下载ZIP含Python和新协议文档。

`node --env-file=.env --import tsx scripts/verify-fidelity-package.ts`通过：旧v1/v2、ZIP、DOCX、原件配对、篡改和上传脚本只读兼容。

skill-creator `quick_validate.py` 以Python `-X utf8`执行通过。Windows默认GBK不能读取UTF8 Skill，需此启动参数。

## 验证边界

字节/文本/位置校验可证明相对所选读取视图完整保留，不证明AI的语义集场划分必然正确。集场未知可使用“-”，保留问题，不强造整集一场。只有结构计划必须配原稿；普通完整清洗稿无原稿可作为独立新基线，不能证明此前未改字。完整标记稿必须采用正式协议，任意外部AI自由格式不自动猜测放行。

候选称呼必须出现在其证据块，问题必须有两到三个不同选项和推荐理由；这些仍是候选，不代表已确认的制作决定。界面、P1实际调用和第二阶段消费由主控集成验收，本子任务测试不代替其验证。
