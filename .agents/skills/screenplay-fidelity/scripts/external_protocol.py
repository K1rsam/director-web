"""Transport adapter only. Node fidelity/2 validates/materializes every decision."""
import hashlib, json, re, sys

def utf16(s):
    return len(s.encode('utf-16-le')) // 2

def parse(source, reply):
    version = hashlib.sha256(source.encode('utf-8')).hexdigest()
    # Only transport padding is removed; | prefixed source text is untouched.
    reply = reply.replace('\r\n', '\n').lstrip(' \t\r\n\ufeff')
    if reply.startswith('```'):
        lines = reply.split('\n')
        while lines and not lines[-1].strip():
            lines.pop()
        if lines[0] not in ('```', '```text', '```txt', '```md') or lines[-1].strip() != '```':
            raise ValueError('代码围栏必须完整且仅包住协议')
        reply = '\n'.join(lines[1:-1])
    lines = reply.split('\n')
    protocol = lines.pop(0) if lines else ''
    if protocol not in ('FIDELITY-TEXT/1', 'FIDELITY-DRAFT/1'):
        raise ValueError('缺少 FIDELITY-TEXT/1 或 FIDELITY-DRAFT/1 标记')
    supplied = lines.pop(0) if lines else ''
    if supplied != 'SOURCE ' + version and not (protocol == 'FIDELITY-DRAFT/1' and supplied == 'SOURCE -'):
        raise ValueError('来源版本不匹配；请使用当前原稿生成的材料')
    blocks = re.findall(r'[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$', source)
    offsets = [0]
    for block in blocks:
        offsets.append(offsets[-1] + utf16(block))
    decisions, aliases, questions, contexts = [], [], [], []
    cursor = 0
    ended = False
    def assignment(kind, start, end, args):
        if end <= start:
            raise ValueError('归属范围不可为空')
        item = dict(start=start, end=end, kind=kind, note='外部结构归属，正文由原稿复制')
        if kind == 'body':
            if len(args) != 2 or not all(x in ('-', 'UNKNOWN') or re.fullmatch(r'(?:0|[1-9]\d*)' if i == 0 else r'[1-9]\d*', x) for i,x in enumerate(args)):
                raise ValueError('BODY 需要正整数集场号；不明确时使用 -')
            known = [x not in ('-', 'UNKNOWN') for x in args]
            if not known[0] and known[1]: raise ValueError('集号不明确时不能指定场号')
            if known[0]: item['episodeNumber'] = int(args[0])
            if known[1]: item['sceneNumber'] = int(args[1])
        else:
            if len(args) != 1 or args[0] not in ('AUTHOR', 'OUTLINE', 'CHARACTERS', 'WORLD', 'OTHER'):
                raise ValueError('CONTEXT 类型无效')
            contexts.append(dict(start=start, end=end, type=args[0]))
        decisions.append(item)
    while lines:
        line = lines.pop(0)
        if line == 'END':
            ended = True
            if any(x.strip() for x in lines): raise ValueError('END 后不可追加文字')
            break
        if not line: continue
        parts = line.split(' ')
        command = parts[0]
        if command in ('ALIAS', 'QUESTION'):
            obj = json.loads(line[len(command)+1:])
            if not isinstance(obj, dict): raise ValueError('候选必须为对象')
            allowed = {'names','evidence','note'} if command == 'ALIAS' else {'question','evidence','options','recommended','reason'}
            if set(obj)-allowed: raise ValueError('候选含未知字段')
            evidence = obj.get('evidence')
            if not isinstance(evidence,list) or not evidence or any(not isinstance(x,str) or not re.fullmatch(r'B\d{6,}',x) or not 1 <= int(x[1:]) <= len(blocks) for x in evidence):
                raise ValueError('候选必须引用有效原文块')
            if command == 'ALIAS':
                if not isinstance(obj.get('names'),list) or len(obj['names'])<2 or any(not isinstance(x,str) or not x for x in obj['names']): raise ValueError('称呼候选至少两个名称')
                quoted = ''.join(blocks[int(x[1:])-1] for x in evidence)
                if any(x not in quoted for x in obj['names']): raise ValueError('称呼候选必须出现在所引原文块中')
                aliases.append(obj)
            else:
                if not isinstance(obj.get('question'),str) or not obj['question'] or not isinstance(obj.get('options'),list) or not 2<=len(obj['options'])<=3 or any(not isinstance(x,str) or not x for x in obj['options']) or obj.get('recommended') not in obj['options']: raise ValueError('问题需要两到三个方案及其中的推荐方案')
                if len(set(obj['options']))!=len(obj['options']) or not isinstance(obj.get('reason'),str) or not obj['reason'].strip(): raise ValueError('问题方案必须互异，推荐必须有理由')
                questions.append(obj)
            continue
        if command not in ('BODY','CONTEXT'): raise ValueError('未知标记：'+command)
        kind = command.lower()
        if protocol == 'FIDELITY-TEXT/1':
            if len(parts)<4 or not all(re.fullmatch(r'B\d{6,}',x) for x in parts[1:3]): raise ValueError('归属需要起止块 ID')
            first,last = [int(x[1:]) for x in parts[1:3]]
            if first != cursor+1 or last < first or last>len(blocks): raise ValueError('块必须按原序连续唯一覆盖，禁止遗漏、重叠或错序')
            assignment(kind,offsets[first-1],offsets[last],parts[3:]);cursor=last
        else:
            # Each source line is prefixed with |. This escapes all protocol-like source text.
            content=[]
            while lines and lines[0].startswith('|'):
                content.append(lines.pop(0)[1:])
            if not lines or lines[0] not in ('TEXT-END LF','TEXT-END CRLF','TEXT-END CR','TEXT-END NONE','TEXT-END NONE-CRLF','TEXT-END NONE-CR'): raise ValueError('正文需要明确 TEXT-END LF/CRLF/CR/NONE/NONE-CRLF/NONE-CR')
            ending=lines.pop(0)
            style=ending.split(' ')[1]
            separator='\r\n' if style in ('CRLF','NONE-CRLF') else '\r' if style in ('CR','NONE-CR') else '\n'
            text=separator.join(content)+ ('' if style.startswith('NONE') else separator)
            if not text or source[cursor:cursor+len(text)]!=text:
                raise ValueError('配对正文不一致（改字、漏段、重复或错序），位置 '+str(utf16(source[:cursor])))
            end=cursor+len(text)
            if utf16(source[:cursor]) not in offsets or utf16(source[:end]) not in offsets: raise ValueError('归属只能位于完整原文行边界')
            assignment(kind,utf16(source[:cursor]),utf16(source[:end]),parts[1:]);cursor=end
    if not ended: raise ValueError('缺少 END，结果可能被截断')
    if cursor != (len(blocks) if protocol=='FIDELITY-TEXT/1' else len(source)): raise ValueError('未完整覆盖原稿尾部')
    return dict(decisions=decisions,metadata=dict(protocol=protocol,sourceVersion=version,aliases=aliases,questions=questions,contextTypes=contexts))

if __name__ == '__main__':
    try:
        data=json.loads(sys.stdin.buffer.read().decode('utf-8'))
        result=dict(ok=True,value=parse(data['sourceText'],data['responseText']))
    except Exception as error:
        result=dict(ok=False,error=str(error))
    sys.stdout.buffer.write(json.dumps(result,ensure_ascii=False).encode('utf-8'))
