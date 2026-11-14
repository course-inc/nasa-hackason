// Question panel: a dock on every tab. Pick an agent (rules / pi-rs), ask, and see each tool call as
// a chip (name, arguments, sources, SQL). Answers only quote tool results.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getAgent, getTools, listAgents, onRegistryChange } from './port';
import { NoModelError, lastModel } from './pirs';
import type { AgentEvent, ToolResult } from './types';
import { useLang, useT } from '../i18n';

export const EXAMPLES = [
  '基地から3km先まで歩いて帰れる？',
  '同じ坂の練習コースを北海道で探して',
  'この訓練、北海道のどこでいつやる？',
  '根拠を見せて',
  '3Dで歩いて見せて',
  '有人ローバーが壊れたら歩いて帰れる？',
  '歩いた記録で火星を歩いて見せて',
];
export const EXAMPLES_EN = [
  'Can I walk back from 3 km out?',
  'Find a practice course in Hokkaido with the same slopes',
  'Where and when in Hokkaido should we train?',
  'Show me the evidence',
  'Show the walk in 3D',
  'If the crewed rover breaks down, can we walk back?',
  'Replay our recorded walk on Mars',
];

interface Call { id: string; name: string; args: unknown; result?: ToolResult; ok?: boolean }
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; agent: string; text: string; calls: Call[]; error?: string; note?: string; done: boolean };

function Chip({ c }: { c: Call }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tool = getTools().find((t) => t.name === c.name);
  const state = c.ok == null ? 'run' : c.ok ? 'ok' : 'ng';
  return (
    <div className={`tool-chip ${state}`}>
      <button className="tool-chip-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-kind">{tool?.kind === 'view' ? t('表示', 'view') : t('計算', 'compute')}</span>
        <code>{c.name}</code>
        <span className="tool-state">{state === 'run' ? (c.name === 'explore_hokkaido' ? t('北海道を探索中…（初回は数秒）', 'Exploring Hokkaido… (a few seconds the first time)') : t('計算中…', 'Computing…')) : state === 'ok' ? '✓' : '✕'}</span>
      </button>
      {open && (
        <div className="tool-chip-body">
          <div className="muted">{t('引数', 'Arguments')}</div>
          <pre>{JSON.stringify(c.args ?? {}, null, 1)}</pre>
          {c.result && <><div className="muted">{t('結果', 'Result')}</div><p>{c.result.text}</p></>}
          {c.result?.sources?.length ? (
            <><div className="muted">{t('出典', 'Sources')}</div>
              <ul>{c.result.sources.map((s) => <li key={s.label}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> : s.label}</li>)}</ul></>
          ) : null}
          {c.result?.sql && <><div className="muted">SQL</div><pre>{c.result.sql}</pre></>}
        </div>
      )}
    </div>
  );
}

export function AgentPanel() {
  const t = useT();
  const lang = useLang();
  const [, bump] = useState(0);
  useEffect(() => onRegistryChange(() => bump((n) => n + 1)), []);
  const [avail, setAvail] = useState<Record<string, boolean>>({});
  const agents = listAgents();
  useEffect(() => {
    let live = true;
    Promise.all(agents.map(async (a) => [a.id, await a.available()] as const)).then((r) => live && setAvail(Object.fromEntries(r)));
    return () => { live = false; };
  }, [agents.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [agentId, setAgentId] = useState<string | null>(null);
  const chosen = agentId ?? (avail['pi-rs'] ? 'pi-rs' : 'rules');

  // Open by default on WALKBACK; elsewhere a small button, so it never covers the other tabs.
  const isWalk = () => /^#(walk|mars)/.test(location.hash) || location.hash.replace('#', '') === '';
  // Phones start with the small button so the map stays usable.
  const narrow = () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 820px)').matches;
  const [open, setOpen] = useState(() => isWalk() && !narrow());
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [items]);
  const used = items.length > 0 || busy;
  useEffect(() => {
    const on = () => { if (!used) setOpen(isWalk() && !narrow()); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [used]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchLast = (f: (it: Extract<Item, { kind: 'agent' }>) => Extract<Item, { kind: 'agent' }>) =>
    setItems((xs) => {
      const i = xs.length - 1, last = xs[i];
      return last?.kind === 'agent' ? [...xs.slice(0, i), f(last)] : xs;
    });

  const onEvent = (e: AgentEvent) => {
    if (e.type === 'text') patchLast((it) => ({ ...it, text: it.text + e.text }));
    else if (e.type === 'tool_call') patchLast((it) => ({ ...it, calls: [...it.calls, { id: e.id, name: e.name, args: e.args }] }));
    else if (e.type === 'tool_result') patchLast((it) => ({ ...it, calls: it.calls.map((c) => (c.id === e.id ? { ...c, result: e.result, ok: e.ok } : c)) }));
    else if (e.type === 'error') patchLast((it) => ({ ...it, error: e.message }));
    else if (e.type === 'done') patchLast((it) => ({ ...it, done: true }));
  };

  const ask = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setQ('');
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    let agent = getAgent(chosen) ?? getAgent('rules')!;
    setItems((xs) => [...xs, { kind: 'user', text: prompt }, { kind: 'agent', agent: agent.id, text: '', calls: [], done: false }]);
    try {
      try {
        await agent.ask(prompt, getTools(), onEvent, ctl.signal);
      } catch (e) {
        if (!(e instanceof NoModelError) || agent.id === 'rules') throw e;
        // No model reachable: say so and answer with the rules version.
        agent = getAgent('rules')!;
        patchLast((it) => ({ ...it, agent: 'rules', note: t(`AI モデルに接続できないため、規則版（AIなし）で答えます。デスクトップ版で ANTHROPIC_API_KEY を設定するか、Ollama を起動してください（${e.message}）`, `No AI model is reachable, so the rules version (no AI) answers. In the desktop app, set ANTHROPIC_API_KEY or start Ollama (${e.message})`) }));
        await agent.ask(prompt, getTools(), onEvent, ctl.signal);
      }
      if (agent.id === 'pi-rs' && lastModel) patchLast((it) => ({ ...it, note: it.note ?? `${lastModel!.provider} / ${lastModel!.model}` }));
    } catch (e) {
      onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      patchLast((it) => ({ ...it, done: true }));
      setBusy(false);
      abort.current = null;
    }
  };

  const label = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.label])), [agents]);

  if (!open) return <button className="agent-fab" onClick={() => setOpen(true)} aria-label={t('質問欄を開く', 'Open the question panel')}>💬 {t('質問する', 'Ask')}</button>;
  return (
    <section className="agent-panel" aria-label={t('質問欄', 'Question panel')}>
      <div className="agent-head">
        <b>{t('質問する', 'Ask WALKBACK')}</b>
        <select aria-label={t('エージェント', 'Agent')} value={chosen} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={avail[a.id] === false}>
              {a.label}{avail[a.id] === false ? t('（デスクトップ版のみ）', ' (desktop app only)') : ''}
            </option>
          ))}
        </select>
        <button className="agent-close" onClick={() => setOpen(false)} aria-label={t('質問欄を閉じる', 'Close the question panel')}>—</button>
      </div>
      <div className="agent-log" ref={logRef}>
        {items.length === 0 && <p className="muted">{t('数字はすべて Rust エンジンと NASA データのツールから。答えはツールの結果だけを使います。下の例を押すか、質問を書いてください。', 'Every number comes from the Rust engine and NASA data tools; answers only quote tool results. Tap an example below or type a question.')}</p>}
        {items.map((it, i) => it.kind === 'user'
          ? <div key={i} className="msg user">{it.text}</div>
          : (
            <div key={i} className="msg agent" data-done={it.done ? '1' : '0'}>
              <div className="msg-who">{label[it.agent] ?? it.agent}{it.note ? ` · ${it.note}` : ''}</div>
              {it.calls.map((c) => <Chip key={c.id} c={c} />)}
              {it.text && <div className="msg-text">{it.text}</div>}
              {!it.done && !it.text && <div className="muted">…</div>}
              {it.error && <div className="warn">{it.error}</div>}
            </div>
          ))}
      </div>
      <div className="agent-examples">
        {(lang === 'ja' ? EXAMPLES : EXAMPLES_EN).map((x) => <button key={x} disabled={busy} onClick={() => ask(x)}>{x}</button>)}
      </div>
      <form className="agent-input" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input id="agent-q" aria-label={t('質問', 'Question')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('例: 酸素6時間で基地から3km先まで帰れる？', 'e.g. With 6 hours of oxygen, can I walk back from 3 km out?')} />
        {busy
          ? <button type="button" onClick={() => abort.current?.abort()}>{t('止める', 'Stop')}</button>
          : <button type="submit" className="primary" disabled={!q.trim()}>{t('聞く', 'Ask')}</button>}
      </form>
    </section>
  );
}
