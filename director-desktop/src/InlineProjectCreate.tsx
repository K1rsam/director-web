import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from './components';
import './inlineProjectCreate.css';

type Props = { writable: boolean; busy: boolean; onCreate: (title: string) => Promise<boolean> };

export function InlineProjectCreate({ writable, busy, onCreate }: Props) {
  const [title, setTitle] = useState(''), [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const cleanTitle = title.trim(), valid = cleanTitle.length > 0 && cleanTitle.length <= 160;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!writable || busy || inFlight.current || !valid) return;
    inFlight.current = true; setPending(true);
    try { if (await onCreate(cleanTitle)) setTitle(''); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <form className="inline-project-create" aria-label="添加新项目" onSubmit={event => void submit(event)}>
    <label>新项目名称<input aria-label="新项目名称" placeholder="输入剧本或项目名称" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} disabled={!writable || busy || pending}/></label>
    <Button type="submit" variant="primary" icon="plus" disabled={!valid || !writable || busy || pending}>{pending ? '正在添加…' : '添加项目'}</Button>
  </form>;
}
