import type { Settings } from './types';

type FantasyMode = 'recommend' | 'off' | 'all' | 'review';
type Props = { settings: Settings; writable: boolean; onChange: (patch: Partial<Settings>) => void };

export function displayedFantasyMode(settings: Settings): FantasyMode {
  const mode = settings.fantasyMode;
  if (mode === 'off' || mode === 'all') return mode;
  return mode === 'review' && settings.requireFantasyReview === true ? 'review' : 'recommend';
}

export function fantasySettingsPatch(mode: FantasyMode): Partial<Settings> {
  return { fantasyMode: mode, requireFantasyReview: mode === 'review' };
}

export function ProductionSettings({ settings, writable, onChange }: Props) {
  return <label>幻想表达<select disabled={!writable} value={displayedFantasyMode(settings)} onChange={event => onChange(fantasySettingsPatch(event.target.value as FantasyMode))}>
    <option value="recommend">自动采用推荐</option>
    <option value="off">不增加额外幻想</option>
    <option value="all">采用全部候选</option>
    <option value="review">先审阅候选</option>
  </select><small className="control-hint">默认自动采用推荐候选并继续制作。选择先审阅后，会等你确认候选。</small></label>;
}
