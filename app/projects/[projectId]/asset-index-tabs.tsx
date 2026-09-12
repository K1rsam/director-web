"use client";

import { useState } from "react";

export type AssetIndexRow = {
  id: string;
  code: string;
  type: string;
  name: string;
  status: string;
  statusLabel?: string;
  parentId?: string | null;
  role?: string | null;
};

const ASSET_INDEX_TABS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "people", label: "人物", types: ["CH", "LOOK"] },
  { key: "groups", label: "群像", types: ["GROUP"] },
  { key: "beasts", label: "非人", types: ["BEAST"] },
  { key: "scenes", label: "场景", types: ["LOC"] },
  { key: "props", label: "道具", types: ["PROP"] },
  { key: "other", label: "其他", types: ["STYLE", "NEG"] }
];

const TYPE_TAG: Record<string, string> = {
  CH: "人物",
  LOOK: "人物状态",
  GROUP: "群像",
  BEAST: "非人",
  LOC: "场景",
  PROP: "道具",
  STYLE: "风格",
  NEG: "负面约束"
};

const TYPE_TAG_CLASS: Record<string, string> = {
  CH: "typePeople",
  LOOK: "typePeople",
  GROUP: "typeGroup",
  BEAST: "typeBeast",
  LOC: "typeScene",
  PROP: "typeProp",
  STYLE: "typeOther",
  NEG: "typeOther"
};

const ROLE_TAG_CLASS: Record<string, string> = {
  主角: "roleLead",
  配角: "roleSupport",
  反派: "roleVillain",
  路人: "roleExtra"
};

export function AssetIndexTabs({ assets }: { assets: AssetIndexRow[] }) {
  const visibleTabs = ASSET_INDEX_TABS.filter((tab) => assets.some((asset) => tab.types.includes(asset.type)));
  const [activeKey, setActiveKey] = useState(visibleTabs[0]?.key ?? "people");
  const activeTab = visibleTabs.find((tab) => tab.key === activeKey) ?? visibleTabs[0] ?? ASSET_INDEX_TABS[0];
  const visible = assets
    .filter((asset) => activeTab.types.includes(asset.type))
    .sort((a, b) => a.code.localeCompare(b.code, "zh-Hans-CN", { numeric: true }));

  if (!assets.length) {
    return <div className="studioTableScroll compactTable"><table><tbody><tr><td colSpan={4} className="emptyCell">尚未拆解资产名称</td></tr></tbody></table></div>;
  }

  const mainAssets = visible.filter((asset) => !asset.parentId);
  const childrenByParent = new Map<string, AssetIndexRow[]>();
  for (const asset of visible) {
    if (!asset.parentId) continue;
    const list = childrenByParent.get(asset.parentId) ?? [];
    list.push(asset);
    childrenByParent.set(asset.parentId, list);
  }
  const orphanChildren = visible.filter((asset) => asset.parentId && !mainAssets.some((main) => main.id === asset.parentId));

  const rows: Array<{ asset: AssetIndexRow; depth: number }> = [];
  for (const main of mainAssets) {
    rows.push({ asset: main, depth: 0 });
    for (const child of childrenByParent.get(main.id) ?? []) rows.push({ asset: child, depth: 1 });
  }
  for (const orphan of orphanChildren) rows.push({ asset: orphan, depth: 1 });

  return (
    <div className="assetIndexTabs">
      <div className="assetTabBar" role="tablist" aria-label="资产分类">
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab.key === tab.key}
            className={activeTab.key === tab.key ? "active" : ""}
            onClick={() => setActiveKey(tab.key)}
          >
            {tab.label}<b>{assets.filter((asset) => tab.types.includes(asset.type)).length}</b>
          </button>
        ))}
      </div>
      <div className="studioTableScroll compactTable">
        <table>
          <thead><tr><th>资产ID</th><th>类型</th><th>名称 / 状态</th><th>{assets.some(asset => asset.statusLabel !== undefined) ? "状态" : "确认"}</th></tr></thead>
          <tbody>
            {rows.map(({ asset, depth }) => (
              <tr key={asset.id} className={depth > 0 ? "assetChildRow" : ""}>
                <td>{asset.code}</td>
                <td>
                  {depth === 0 ? (
                    <span className="assetTags">
                      <i className={`assetTypeTag ${TYPE_TAG_CLASS[asset.type] ?? "typeOther"}`}>{TYPE_TAG[asset.type] ?? asset.type}</i>
                      {asset.role ? <i className={`assetRoleTag ${ROLE_TAG_CLASS[asset.role] ?? ""}`}>{asset.role}</i> : null}
                    </span>
                  ) : null}
                </td>
                <td style={depth > 0 ? { paddingLeft: "34px" } : undefined}>
                  {depth > 0 ? <span className="assetChildMarker" aria-hidden="true">└ </span> : null}{asset.name}
                </td>
                <td><span className={`stateDot ${asset.statusLabel ? "" : asset.status === "confirmed" ? "ok" : "warn"}`}>{asset.statusLabel ?? (asset.status === "confirmed" ? "已确认" : "待确认")}</span></td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={4} className="emptyCell">该分类暂无资产</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
