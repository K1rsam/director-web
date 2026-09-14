import { confirmFoundationDeliveryChoiceAction, decidePresentationContractAction } from "@/app/actions";
import type { FoundationChoiceView } from "@/lib/foundation-choice-store";
import styles from "./presentation-contracts.module.css";
import { ChoiceSubmitButton } from "./choice-submit-button";

const categoryLabel = (category: string) => category === "asset_identity" ? "资产身份"
  : category === "SOURCE_CONFLICT" ? "原文取舍"
    : category === "PRODUCTION_CHOICE" ? "制作取舍" : category;
const scopeLabel = (episodes: number[]) => episodes.length ? `第${episodes.join("、")}集` : "全剧";

/** F1/F2/Q1 共用的必要人工取舍入口；展示推荐，但仅在用户明确提交时保存。 */
export function PresentationContracts({
  projectId,
  pending,
  confirmed,
  active = false,
  mode = "legacy",
  expectedTaskId,
  blockedReason,
  decisionContinued = false,
  decisionCollected = false
}: {
  projectId: string;
  pending: FoundationChoiceView[];
  confirmed: FoundationChoiceView[];
  active?: boolean;
  mode?: "legacy" | "delivery";
  expectedTaskId?: string;
  blockedReason?: string;
  decisionContinued?: boolean;
  decisionCollected?: boolean;
}) {
  if (!pending.length && !confirmed.length && !active && !decisionContinued && !decisionCollected) return null;
  const delivery = mode === "delivery";
  const action = delivery ? confirmFoundationDeliveryChoiceAction : decidePresentationContractAction;
  return (
    <section className={styles.section} id="presentation-contracts" aria-labelledby="foundation-choices-heading">
      <div className={styles.header}>
        <div><span>{delivery ? "必要取舍" : "F1 · F2 · Q1"}</span><h3 id="foundation-choices-heading">{pending.length ? "需要你确认" : "已确认的决定"}</h3></div>
        <span aria-live="polite">{pending.length} 项待确认 · {confirmed.length} 项{delivery ? "已保存" : "已确认"}</span>
      </div>
      {pending.length ? <p className={styles.hint}>这里只收集原文和现有资料无法替你决定的取舍。请选择一个方案，或写下自定义方案；推荐只是建议，不会自动选中。{delivery ? "点击方案保存选择，可连续完成其余事项；全部必要选择保存后，系统才会自动整理。" : ""}</p> : null}
      {decisionCollected && !active ? <p role="status" className={styles.running}>{pending.length ? `本次选择已保存，仍有 ${pending.length} 项待确认。请继续选择；全部完成后会自动整理。` : "本次选择已保存，请查看当前整理状态。"}</p> : null}
      {active ? <p role="status" className={styles.running}>{blockedReason ?? "请先等待当前运行结束。系统正在处理资料，页面会自动更新；新的待确认事项会显示在这里。"}</p> : decisionContinued ? <p role="status" className={styles.running}>{pending.length ? `决定已保存，本轮处理已结束。仍有 ${pending.length} 项需要你确认，请继续查看下方事项。` : "决定已保存，本轮处理已结束。当前没有待确认事项，请查看上方整理状态。"}</p> : null}
      {pending.map((contract, choiceIndex) => {
        const recommendedIndex = contract.recommended ? contract.options.indexOf(contract.recommended) : -1;
        // Historical option arrays may contain a custom-input placeholder; retain every real option's stored index.
        const options = contract.options.map((text, index) => ({ text, index })).filter(({ text }) => !/^(?:[A-Z][.、．]\s*)?(?:用户)?自定义(?:方案)?(?:…|\.{3})?$/.test(text.trim()));
        return (
          <article className={styles.card} id={`choice-card-${contract.id}`} key={contract.id} aria-labelledby={`choice-${contract.id}`}>
            <div className={styles.meta}>
              <span>待确认 {choiceIndex + 1} / {pending.length}</span>
              <span>{categoryLabel(contract.category)}</span>
              <span>{scopeLabel(contract.episodes)}</span>
              {!delivery ? <span>{contract.sourceStages.length ? `来源：${contract.sourceStages.join(" · ")}` : "来源未记录"}</span> : null}
            </div>
            <h4 id={`choice-${contract.id}`}>{contract.question}</h4>
            {contract.reason || contract.evidence || (delivery && contract.sourceStages.length) ? (
              <details className={styles.evidence}>
                <summary>为什么需要你决定 · 查看依据</summary>
                {contract.reason ? <p>{contract.reason}</p> : null}
                {contract.evidence ? <p>原文依据：{contract.evidence}</p> : null}
                {delivery && contract.sourceStages.length ? <p>处理来源：{contract.sourceStages.join(" · ")}</p> : null}
              </details>
            ) : null}
            <div className={styles.options}>
              {options.map(({ text, index }) => (
                <form action={action} key={index} className={styles.option}>
                  <input name="projectId" type="hidden" value={projectId} />
                  <input name="contractId" type="hidden" value={contract.id} />
                  <input name="revision" type="hidden" value={contract.revision} />
                  {delivery ? <input name="expectedTaskId" type="hidden" value={expectedTaskId ?? ""} /> : null}
                  <ChoiceSubmitButton name="optionIndex" value={index} disabled={active} className={`${styles.optionButton} ${index === recommendedIndex ? styles.recommended : ""}`}>
                    <span className={styles.optionLabel}><b>{String.fromCharCode(65 + index)}</b>{index === recommendedIndex ? <em>推荐</em> : null}</span>
                    <span>{text}</span>
                    {delivery ? <span>保存选择</span> : null}
                  </ChoiceSubmitButton>
                  {index === recommendedIndex && contract.recommendationReason ? <p className={styles.recommendationReason}>推荐理由：{contract.recommendationReason}</p> : null}
                </form>
              ))}
            </div>
            <form action={action} className={styles.custom}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="contractId" type="hidden" value={contract.id} />
              <input name="revision" type="hidden" value={contract.revision} />
              {delivery ? <input name="expectedTaskId" type="hidden" value={expectedTaskId ?? ""} /> : null}
              <label htmlFor={`custom-${contract.id}`}>自定义方案</label>
              <textarea id={`custom-${contract.id}`} name="customAnswer" rows={2} required disabled={active} placeholder="写下你的具体决定…" />
              <ChoiceSubmitButton disabled={active}>保存自定义方案</ChoiceSubmitButton>
            </form>
            {pending[choiceIndex + 1] ? <a href={`#choice-card-${pending[choiceIndex + 1].id}`}>查看下一项（{choiceIndex + 2} / {pending.length}）</a> : null}
          </article>
        );
      })}
      {pending.length ? <p className={styles.hint}>{delivery ? "每项选择都会单独保存，保存后会显示剩余事项。全部必要选择完成后统一应用；整理时如出现新的必要取舍，会继续在这里提示。已生成的资料保留可读。" : "这里只保存决定，不自动运行。决定改变后可能需要更新 F1、F2、Q1；继续前请核对实际范围，旧稿仍保留。"}</p> : null}
      {confirmed.length ? (
        <details className={styles.confirmed}>
          <summary>已确认的决定（{confirmed.length}）</summary>
          {confirmed.map((contract) => (
            <div key={contract.id} className={styles.confirmedItem}>
              <p><b>{categoryLabel(contract.category)}</b> · {scopeLabel(contract.episodes)}{contract.decidedAt ? <> · <time dateTime={contract.decidedAt.toISOString()}>{contract.decidedAt.toISOString().slice(0, 10)}</time></> : null}</p>
              <p>{contract.question}</p>
              <p>{contract.userAnswer}</p>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
