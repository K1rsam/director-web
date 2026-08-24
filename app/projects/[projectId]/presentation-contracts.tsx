import { decidePresentationContractAction, skipPresentationContractAction } from "@/app/actions";

type ContractRow = {
  id: string;
  category: string;
  question: string;
  options: string[];
  evidence: string | null;
  userAnswer: string | null;
  episodeNumber: number | null;
  round: number;
  decidedAt: Date | null;
};

/** 表现规范确认面板：P1 通读全剧本后提出的"非常规表现元素"由用户拍板，锁定后注入 P2 与 E1-E5。 */
export function PresentationContracts({
  projectId,
  pending,
  confirmed
}: {
  projectId: string;
  pending: ContractRow[];
  confirmed: ContractRow[];
}) {
  if (!pending.length && !confirmed.length) return null;
  return (
    <section className="contractSection" id="presentation-contracts">
      <div className="cardHeader">
        <div><span>PRESENTATION CONTRACTS</span><h3>表现规范确认（P1 发现，需你拍板）</h3></div>
        <em>{pending.length}待确认 · {confirmed.length}已锁定</em>
      </div>
      <p className="contractHint">剧本里出现系统、Q版、特效、血腥等非常规表现元素时，先定"怎么演"再生成分镜——否则 Seedance 无法判断 Q版苏远 该以什么形态出现，资产也无法提前建立。选 A/B/C 或输入自定义方案。</p>
      {pending.length ? [...pending].sort((a, b) => a.round - b.round || a.category.localeCompare(b.category)).map((contract) => (
        <article className="contractCard" key={contract.id}>
          <div className="contractHead">
            <span>{contract.category}</span>
            <b>{contract.question}</b>
            <em>{contract.round > 1 ? `第${contract.round}轮 · ` : ""}{contract.episodeNumber ? `第${contract.episodeNumber}集` : "全剧"}</em>
          </div>
          {contract.evidence ? <p className="contractEvidence">出现处：{contract.evidence}</p> : null}
          <div className="contractOptions">
            {contract.options.map((option, index) => {
              const label = String.fromCharCode(65 + index);
              return (
                <form action={decidePresentationContractAction} key={label}>
                  <input name="projectId" type="hidden" value={projectId} />
                  <input name="contractId" type="hidden" value={contract.id} />
                  <input name="answer" type="hidden" value={`${label}. ${option}`} />
                  <button type="submit" title={option}><b>{label}</b> {option.slice(0, 60)}{option.length > 60 ? "…" : ""}</button>
                </form>
              );
            })}
            <form action={decidePresentationContractAction} className="contractCustom">
              <input name="projectId" type="hidden" value={projectId} />
              <input name="contractId" type="hidden" value={contract.id} />
              <input name="answer" type="text" placeholder="D. 自定义方案…" required />
              <button type="submit">自定义</button>
            </form>
            <form action={skipPresentationContractAction}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="contractId" type="hidden" value={contract.id} />
              <button type="submit" className="contractSkip">暂不处理</button>
            </form>
          </div>
        </article>
      )) : null}
      {confirmed.length ? (
        <details className="contractConfirmed">
          <summary>已锁定的表现规范（{confirmed.length}）</summary>
          {confirmed.map((contract) => (
            <p key={contract.id}><b>{contract.category}</b>：{contract.userAnswer}</p>
          ))}
        </details>
      ) : null}
    </section>
  );
}
