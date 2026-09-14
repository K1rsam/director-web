# FIDELITY-TEXT/1 普通文本协议

真实第0集/序章剧情可用集号0，与fidelity/3一致；场号仍为正整数。原集号0保留在来源，不自动当作者资料。制作展示号另行排序。

支持粘贴、UTF-8 TXT、MD、DOCX，不支持旧DOC。DOCX逐段读取为LF，正文字符不做模糊匹配。只允许一个完整协议，可用完整的 text/txt/md Markdown代码围栏包住。

每个 BLOCK 是完整原文行（含换行），ID按原顺序固定。SOURCE复制网站值。回复：

```text
FIDELITY-TEXT/1
SOURCE 从网站材料原样复制的版本
CONTEXT B000001 B000003 AUTHOR
BODY B000004 B000012 1 1
BODY B000013 B000020 1 2
ALIAS {"names":["张三","老张"],"evidence":["B000005"],"note":"同一句自称与称呼对应，仍为候选"}
QUESTION {"question":"钥匙交接存在两种理解","evidence":["B000018"],"options":["甲持有","乙持有"],"recommended":"乙持有","reason":"交接动作的直接依据"}
END
```

BODY依次为起止块、集号、场号。明确时用正整数，不明确用 `-` 或 `UNKNOWN`；集号不明时场号也必须未知，禁止为了通过解析虚构整集一场。上述范围仅为语法示例，不能照抄。CONTEXT类型只支持 AUTHOR、OUTLINE、CHARACTERS、WORLD、OTHER。全部块按原顺序连续覆盖且恰好一次，禁止重叠、漏尾、错序。ALIAS/QUESTION为可选JSON单行，字符串内双引号、反斜线、换行遵循JSON转义。未知字段拒绝，证据必须是当前块ID；候选不会修改正文。END必填且其后只允许空行。

## 已有完整稿：FIDELITY-DRAFT/1

没有系统版本可使用 SOURCE -，但必须另附原稿。每个正文行加一个 `|` 前缀，包括空行。原文以 `|` 开头也再加一个 `|`，解析只去掉最前一个。原文任何同名标记都放在 `|` 后，因而不会被当成协议。每段用 TEXT-END LF（正文有末尾LF）或 TEXT-END NONE（正文无末尾LF）结束，禁止删除正文空白。

```text
FIDELITY-DRAFT/1
SOURCE -
BODY 1 1
|第一集
|1-1 客厅 日 内
|甲：aaa
TEXT-END LF
BODY 1 2
|1-2 门外 日 外
|乙：END
TEXT-END NONE
END
```

示例原稿第1至4行各有LF，第5行无末尾换行。程序按来源顺序逐字匹配并检查行边界，相同句子不会被自动搜索到别的位置。不接受忽略空白或相似度放行。不规范历史标题可保留普通全文配原稿直接验证；如果添加新标题，必须使用独立BODY标记，不能把新标题塞进正文。

原稿使用CRLF或CR时，以 TEXT-END CRLF 或 TEXT-END CR 表示段内及末尾的准确换行；末尾无换行但段内用CRLF/CR时使用 TEXT-END NONE-CRLF / TEXT-END NONE-CR。混合行尾分为不同段，不能把原稿行尾统一改写后冒称逐字一致。

Python只输出适配计划，保真通过必须再经Node fidelity/3。逐字通过不证明集场建议一定正确。称呼候选每个名称必须出现在所引块中；问题方案必须互异且推荐理由非空。
