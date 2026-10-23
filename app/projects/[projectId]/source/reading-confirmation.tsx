import type {SourceReadingState} from '@/lib/source-reading-confirmation';

export function SourceReadingConfirmation({projectId,state,canConfirm,action}:{projectId:string;state:SourceReadingState;canConfirm:boolean;action:(form:FormData)=>Promise<void>}){
 if(!state.required)return null;
 return <section aria-label="读取版本确认">
  <h3>Word 修订与读取文本</h3>
  <p>原 Word 有修订标记。这里只确认是否采用下方当前读取文本，不接受或拒绝 Word 修订，不改原件、不重跑已检查内容，也不启动模型。</p>
  {state.confirmed?<p role="status">已确认采用当前读取文本；原件、修订记录和读取警告继续保留。</p>
   :!state.binding?<p role="alert">读取来源证据不完整，暂不能确认。请保留原件并核对读取记录。</p>
   :!canConfirm?<p>需要本项目管理员或审阅者确认读取版本。</p>
   :<form action={action}>
    <input type="hidden" name="projectId" value={projectId}/>
    {Object.entries(state.binding).map(([name,value])=><input key={name} type="hidden" name={name} value={value}/>)}
    <input type="hidden" name="choice" value="USE_CURRENT_READING"/>
    <label><input type="checkbox" name="confirmed" required/>我已核对当前读取文本，明确同意使用；原 Word 与修订记录保留。</label>
    <button type="submit">确认读取版本（不调用模型）</button>
   </form>}
 </section>;
}
