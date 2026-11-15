// Cloud AI with the person's own OpenAI key (settings screen). The browser calls OpenAI directly,
// so the key stays in this browser and never reaches our relay. Same system prompt and the same
// Anthropic-shaped messages as the relay (web/public/_worker.js), translated to chat completions here.
import { getSettings } from '../settings';

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

/** Keep in step with SYSTEM in web/public/_worker.js (a unit test compares them). */
export const SYSTEM = `あなたは WALKBACK（火星の船外活動で「歩いて帰れるか」を判定するアプリ）の相棒。質問には必ず先にツールを呼ぶ。
- 帰れるか・距離・時間・酸素や冷却水の条件の質問は walkback_check（数値条件は o2_h などの引数に入れる。「Nkm先」は route={"away_km":N}）。練習コースは walkback_check に with_rehearsal=true。
- ローバーが壊れたら・どこで引き返すかは rover_walkback。目的地までの道を自動で引くときは plan_route（lat, lon）。経路の評価・比較・説明は evaluate_route（距離・時間・登り下り・坂・足場・出発時刻別の酸素と冷却水・放射線・区間ごと、出典付き）の数字をそのまま使う。
- 根拠・出典は open_evidence（topic は rover, eva, consumables など）。
- 北海道のどこで・いつ訓練するかは explore_hokkaido。歩いた記録・GPX は import_walk。
- 見せてと言われたら表示ツール（view_3d, view_walk, view_globe など）で地図を動かす。
- 件数・範囲・一覧など、ほかのツールで答えられない質問は query_nasa に読み取り専用の SELECT を1つ渡して表から引く（集計や WHERE で絞る）。Perseverance が何 km 走ったか・sol ごとの位置は rover_traverse 表（例: SELECT max(km) FROM rover_traverse WHERE sol <= 1000）。船外活動の回数や時間は eva 表。Jezero の足場（熱慣性・ダスト被覆）は mars_footing 表。船外活動の放射線（Curiosity RAD の線量率と NASA の上限）は mars_radiation 表。Jezero の時刻ごとの気温・気圧（Perseverance MEDA）は mars_weather 表。火星の地名・着陸地点・有人着陸の候補地は mars_names 表（例: SELECT name, lat, lon, diameter_km FROM mars_names WHERE name ILIKE '%Jezero%'）。
- walkback_check は歩く計画の判定だけに使う。
数字の決まり（最重要）: 答えに書く数字は、ツールの結果の文に出てくる数字だけを、そのまま写す。自分で計算・換算・四捨五入・推測をしない。ツールで出せない数字は「ツールでは出せません」と言う。
最後に出典（sources）を一言添える。ユーザーの言語で、短く（3〜6文）答える。答えはそのまま文字で表示されるので、**太字** や見出しなどのマークダウン記法は使わない（箇条書きは「・」で）。`;

type Block = { type: string; [k: string]: unknown };
interface Msg { role: 'user' | 'assistant'; content: string | Block[] }
export interface Spec { name: string; description: string; input_schema: unknown }
export interface Reply { content: Block[]; stop_reason: string; model?: string }

/** Anthropic messages → OpenAI chat messages (thinking blocks dropped). */
export function toOpenAI(system: string, messages: Msg[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
        else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    }
  }
  return out;
}

interface Completion { model?: string; choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] } }[] }
/** OpenAI chat completion → Anthropic message shape. */
export function fromOpenAI(r: Completion): Reply {
  const msg = r.choices?.[0]?.message ?? {};
  const content: Block[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const fin = r.choices?.[0]?.finish_reason;
  const stop_reason = fin === 'tool_calls' || (msg.tool_calls?.length ?? 0) > 0 ? 'tool_use' : fin === 'length' ? 'max_tokens' : 'end_turn';
  return { model: r.model, stop_reason, content };
}

/** The settings say to use the person's own OpenAI key, and one is entered. */
export const openaiOn = () => { const s = getSettings(); return s.cloudVia === 'openai' && !!s.openaiKey.trim(); };

/** One model turn on OpenAI. */
export async function openaiTurn(messages: Msg[], specs: Spec[], signal?: AbortSignal): Promise<Reply> {
  const s = getSettings();
  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.openaiKey.trim()}` },
    body: JSON.stringify({
      model: s.openaiModel.trim() || 'gpt-5-mini',
      messages: toOpenAI(SYSTEM, messages),
      tools: specs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Completion & { error?: { message?: string } };
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenAI のキーが正しくありません / the OpenAI key was rejected' : `OpenAI ${res.status}: ${body.error?.message ?? ''}`);
  return fromOpenAI(body);
}
