import {
  decidePresentationContractAction,
  skipPresentationContractAction
} from "@/app/actions";
import {
  formatPresentationContractScope,
  formatPresentationEpisodeNumbers,
  type PresentationContractScopeMode
} from "@/lib/presentation-contracts";

type ContractRow = {
  id: string;
  category: string;
  question: string;
  options: string[];
  evidence: string | null;
  userAnswer: string | null;
  sourceEpisodeNumber: number | null;
  episodeNumbers: number[];
  scopeMode: PresentationContractScopeMode;
  round: number;
  decidedAt: Date | null;
};

function cleanOption(option: string): string {
  return option.replace(/^\s*[A-ZＡ-Ｄ][\.．、]\s*/, "").trim();
}

function ContractScopeEditor({
  contract,
  formalEpisodeNumbers
}: {
  contract: ContractRow;
  formalEpisodeNumbers: number[];
}) {
  const discoveredNumbers = contract.scopeMode === "ALL_EPISODES"
    ? []
    : contract.episodeNumbers.length
      ? contract.episodeNumbers
      : contract.sourceEpisodeNumber !== null
        ? [contract.sourceEpisodeNumber]
        : [];
  const discovered = contract.scopeMode === "ALL_EPISODES"
    ? "全部" + formalEpisodeNumbers.length + "集（当前设置）"
    : discoveredNumbers.length
      ? formatPresentationEpisodeNumbers(discoveredNumbers)
      : contract.sourceEpisodeNumber !== null
        ? "第" + contract.sourceEpisodeNumber + "集"
        : "P1 尚未给出正式集范围";

  return (
    <div className="contractScopeEditor">
      <input name="targetEpisodeSelectionPresent" type="hidden" value="1" />
      <div className="contractScopeLabel">
        <strong>适用范围</strong>
        <span>这条规则要传给哪些正式集？</span>
      </div>
      <div className="contractScopeControls">
        <select name="scopeMode" defaultValue={contract.scopeMode} aria-label="表现规范适用范围">
          <option value="SOURCE_EPISODES">只应用到发现的相关集（推荐）</option>
          <option value="SELECTED_EPISODES">应用到我指定的集</option>
          <option value="ALL_EPISODES">应用到全部正式集</option>
        </select>
        <input
          name="targetEpisodeNumbers"
          type="text"
          defaultValue=""
          placeholder="还可补充集号，例如：1、10、20"
          aria-label="指定表现规范适用的集号"
        />
      </div>
      {discoveredNumbers.length ? (
        <fieldset className="contractEpisodeChoices">
          <legend>P1 识别的相关集（可调整）</legend>
          <div>
            {discoveredNumbers.map((number) => (
              <label key={number}>
                <input name="targetEpisodeNumber" type="checkbox" value={number} defaultChecked />
                <span>第{number}集</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className="contractScopeHelp">
        P1 定位：{discovered}。默认只传给这些相关集；勾选或补充集号后，只有所选集的 P2 和 E0–E5 会收到这条规则。
        选择“全部正式集”时无需填写集号。当前项目共 {formalEpisodeNumbers.length} 集。
      </p>
    </div>
  );
}

function ContractDecisionForm({
  projectId,
  contract,
  formalEpisodeNumbers,
  editing = false
}: {
  projectId: string;
  contract: ContractRow;
  formalEpisodeNumbers: number[];
  editing?: boolean;
}) {
  return (
    <form action={decidePresentationContractAction} className={"contractDecisionForm" + (editing ? " contractDecisionFormEditing" : "")}>
      <input name="projectId" type="hidden" value={projectId} />
      <input name="contractId" type="hidden" value={contract.id} />
      <ContractScopeEditor contract={contract} formalEpisodeNumbers={formalEpisodeNumbers} />
      <div className="contractOptionsLabel">确认后，仅适用集的 P2 和 E0–E5 会使用这条规则：</div>
      <div className="contractOptions" role="group" aria-label="表现规范方案">
        {contract.options.map((option, index) => {
          const label = String.fromCharCode(65 + index);
          const text = cleanOption(option);
          return (
            <button
              type="submit"
              name="answer"
              value={`${label}. ${text}`}
              className="contractOptionButton"
              data-control="choice"
              aria-pressed={contract.userAnswer === `${label}. ${text}`}
              title={text}
              key={label}
            >
              <b>{label}</b>
              <span>{text}</span>
            </button>
          );
        })}
        <div className="contractCustom">
          <input name="customAnswer" type="text" placeholder="输入自定义方案…" aria-label="自定义表现规范方案" />
          <button type="submit" name="useCustom" value="1" className="studioButton contractCustomAction" data-variant="secondary">使用自定义</button>
        </div>
      </div>
      {editing ? <p className="contractEditNote">修改后会同步后台；只影响之后新生成或返修的任务，已有成品不会被自动重写。</p> : null}
    </form>
  );
}

function SkipContractForm({ projectId, contractId }: { projectId: string; contractId: string }) {
  return (
    <form action={skipPresentationContractAction} className="contractSkipForm">
      <input name="projectId" type="hidden" value={projectId} />
      <input name="contractId" type="hidden" value={contractId} />
      <button type="submit" className="studioButton contractSkip" data-variant="ghost">暂不处理</button>
    </form>
  );
}

function ConfirmedContractList({
  projectId,
  contracts,
  formalEpisodeNumbers
}: {
  projectId: string;
  contracts: ContractRow[];
  formalEpisodeNumbers: number[];
}) {
  return (
    <div className="contractConfirmedList">
      {contracts.map((contract) => (
        <details className="contractConfirmedItem" key={contract.id}>
          <summary>
            <span className="contractCategoryBadge">{contract.category}</span>
            <b>{contract.userAnswer || "已确认"}</b>
            <em>适用：{formatPresentationContractScope({
              scope_mode: contract.scopeMode,
              target_episode_numbers: contract.episodeNumbers,
              source_episode_number: contract.sourceEpisodeNumber
            }, formalEpisodeNumbers)}</em>
            <i>编辑</i>
          </summary>
          <div className="contractConfirmedItemBody">
            <p className="contractConfirmedQuestion">{contract.question}</p>
            {contract.evidence ? <p className="contractEvidence">原文依据：{contract.evidence}</p> : null}
            <ContractDecisionForm
              projectId={projectId}
              contract={contract}
              formalEpisodeNumbers={formalEpisodeNumbers}
              editing
            />
          </div>
        </details>
      ))}
    </div>
  );
}

function ConfirmedContracts({
  projectId,
  contracts,
  formalEpisodeNumbers
}: {
  projectId: string;
  contracts: ContractRow[];
  formalEpisodeNumbers: number[];
}) {
  if (!contracts.length) return null;
  return (
    <details className="contractConfirmed">
      <summary>已锁定的表现规范（{contracts.length}）<span>可展开编辑适用集和方案</span></summary>
      <ConfirmedContractList projectId={projectId} contracts={contracts} formalEpisodeNumbers={formalEpisodeNumbers} />
    </details>
  );
}

/** P1 发现非常规表现元素，确认时明确规则的适用集，避免把无关上下文灌给全部集。 */
export function PresentationContracts({
  projectId,
  pending,
  confirmed,
  formalEpisodeNumbers
}: {
  projectId: string;
  pending: ContractRow[];
  confirmed: ContractRow[];
  formalEpisodeNumbers: number[];
}) {
  if (!pending.length && !confirmed.length) return null;

  if (!pending.length && confirmed.length) {
    return (
      <section className="contractSection contractSectionCompact" id="presentation-contracts">
        <details className="contractCompactDetails">
          <summary>
            <span>PRESENTATION CONTRACTS</span>
            <b>表现规范已锁定</b>
            <em>{confirmed.length} 项</em>
            <i>查看 / 编辑</i>
          </summary>
          <div className="contractCompactBody">
            <ConfirmedContractList projectId={projectId} contracts={confirmed} formalEpisodeNumbers={formalEpisodeNumbers} />
          </div>
        </details>
      </section>
    );
  }

  return (
    <section className="contractSection" id="presentation-contracts">
      <div className="cardHeader">
        <div><span>PRESENTATION CONTRACTS</span><h3>表现规范确认（P1 发现，需你拍板）</h3></div>
        <em>{pending.length} 待确认 · {confirmed.length} 已锁定</em>
      </div>
      <p className="contractHint">只处理 P1 依据原文定位到的非常规表现。确认时请同时选择适用范围：默认只传给相关集；只有明确选择“全部正式集”才会全剧使用。</p>
      {[...pending]
        .sort((left, right) => left.round - right.round || left.category.localeCompare(right.category))
        .map((contract) => (
          <article className="contractCard" key={contract.id}>
            <div className="contractHead">
              <span>{contract.category}</span>
              <b>{contract.question}</b>
              <em>{contract.round > 1 ? "第" + contract.round + "轮 · " : ""}{contract.sourceEpisodeNumber !== null ? "发现于第" + contract.sourceEpisodeNumber + "集" : "P1 定位"}</em>
            </div>
            {contract.evidence ? <p className="contractEvidence">出现处：{contract.evidence}</p> : null}
            <ContractDecisionForm projectId={projectId} contract={contract} formalEpisodeNumbers={formalEpisodeNumbers} />
            <SkipContractForm projectId={projectId} contractId={contract.id} />
          </article>
        ))}
      <ConfirmedContracts projectId={projectId} contracts={confirmed} formalEpisodeNumbers={formalEpisodeNumbers} />
    </section>
  );
}
