// Rules agent: no AI. Picks tools from keywords in a Japanese or English question and answers by
// joining the tools' own text. It never computes or invents a number: the only numbers it adds to a
// tool call are ones typed in the question ("酸素6時間", "3 km").
import { callTool } from './port';
import type { AgentEvent, AgentPort, ToolDef, ToolResult } from './types';

export type Lang = 'ja' | 'en';
export interface Step { name: string; args: Record<string, unknown> }

export const detectLang = (q: string): Lang => (/[぀-ヿ一-鿿]/.test(q) ? 'ja' : 'en');

const toHalf = (q: string) => q.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/３Ｄ|3Ｄ|３D/g, '3D');
const NUM = '(\\d+(?:\\.\\d+)?)';
const pick = (q: string, ...res: RegExp[]) => {
  for (const re of res) { const m = q.match(re); if (m) return Number(m[1]); }
  return undefined;
};

/** Slider values typed in the question. */
export function extractParams(q: string): Record<string, number> {
  const p: Record<string, number> = {};
  const o2 = pick(q, new RegExp(`酸素[^\\d]{0,4}${NUM}\\s*(?:時間|h)`, 'i'), new RegExp(`(?:o2|o₂|oxygen)[^\\d]{0,6}${NUM}\\s*(?:h|hours?)`, 'i'), new RegExp(`${NUM}\\s*(?:h|hours?)\\s*(?:of\\s*)?(?:o2|o₂|oxygen)`, 'i'));
  const water = pick(q, new RegExp(`(?:冷却水|水)[^\\d]{0,4}${NUM}\\s*(?:時間|h)`, 'i'), new RegExp(`water[^\\d]{0,6}${NUM}\\s*(?:h|hours?)`, 'i'), new RegExp(`${NUM}\\s*(?:h|hours?)\\s*(?:of\\s*)?(?:cooling\\s*)?water`, 'i'));
  const speed = pick(q, new RegExp(`(?:速さ|速度|時速)[^\\d]{0,4}${NUM}`, 'i'), new RegExp(`${NUM}\\s*km\\s*/\\s*h`, 'i'), new RegExp(`speed[^\\d]{0,6}${NUM}`, 'i'));
  const reserve = pick(q, new RegExp(`(?:余裕|予備)[^\\d]{0,4}${NUM}\\s*[%％]`, 'i'), new RegExp(`reserve[^\\d]{0,6}${NUM}\\s*%`, 'i'), new RegExp(`${NUM}\\s*%\\s*reserve`, 'i'));
  if (o2 != null) p.o2_h = o2;
  if (water != null) p.water_h = water;
  if (speed != null) p.speed_kmh = speed;
  if (reserve != null) p.reserve = reserve;
  return p;
}

/** Distance typed in the question ("3km先", "3 km"), excluding km/h speeds. */
export function extractKm(q: string): number | undefined {
  const m = q.match(new RegExp(`${NUM}\\s*(?:km|ｋｍ|キロ)(?!\\s*/\\s*h)`, 'i'));
  return m ? Number(m[1]) : undefined;
}

const has = (q: string, re: RegExp) => re.test(q);

/** Which tools to call, in order. */
export function plan(question: string, available: Set<string>): Step[] {
  const q = toHalf(question);
  const lang = detectLang(q);
  const steps: Step[] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => { if (available.has(name)) steps.push({ name, args }); };

  const params = extractParams(q);
  const km = extractKm(q);
  const wantPlay = has(q, /歩いて見せ|歩く(?:様子|ところ)|ヘルメット|helmet|play|show (?:me )?(?:the )?walk|walk me/i);
  const want3d = has(q, /3D|立体|俯瞰|three.?d/i);
  const wantRehearsal = has(q, /練習|同じ坂|リハーサル|practi[cs]e|rehears|same slope/i);
  const wantExplore = !wantRehearsal && has(q, /どこで|いつ|訓練|季節|時期|裸地|火山|火星っぽ|where|when|season|train|volcan/i);
  const wantEvidence = has(q, /根拠|出典|本当|ソース|データ元|証拠|evidence|source|really|proof|why/i);
  const wantCheck = has(q, /帰れ|戻れ|帰って|戻って|歩いて帰|帰還|間に合|return|walk back|get back|make it back|come back/i) || (km != null && !wantExplore);

  if (Object.keys(params).length) add('view_set_params', params);
  if (wantCheck || wantRehearsal || (wantPlay && !wantExplore)) {
    const args: Record<string, unknown> = { lang };
    if (km != null) args.route = /走|ローバー|探査車|drive|rover/i.test(q) ? { along_rover_km: km } : { away_km: km };
    if (wantRehearsal) args.with_rehearsal = true;
    add('walkback_check', args);
    if (wantRehearsal) add('view_overlay', { rehearsal_index: 0 });
  }
  if (wantExplore) {
    const bare = has(q, /裸地|火山|植物がない|植生がない|火星っぽ|bare|volcan|no vegetation|mars-like/i);
    add('explore_hokkaido', { target: 'jezero', test: 'walk', n: 5, ...(bare ? { bare_only: true } : {}) });
  }
  if (wantEvidence) {
    const topics: string[] = [];
    if (has(q, /探査車|ローバー|パーシビアランス|rover|perseverance|drive/i)) topics.push('rover');
    if (has(q, /船外|EVA|宇宙遊泳|spacewalk/i)) topics.push('eva');
    if (has(q, /北海道|hokkaido/i)) topics.push('hokkaido_terrain');
    else if (has(q, /地形|標高|terrain|elevation|DEM/i)) topics.push('terrain');
    if (has(q, /酸素|冷却水|水|消耗|O2|oxygen|water|consumab/i) && !Object.keys(params).length) topics.push('consumables');
    for (const topic of topics.length ? topics : ['rover', 'eva', 'consumables']) add('open_evidence', { topic, lang });
  }
  if (!wantExplore && has(q, /季節|冬|夏|重み|season|winter|summer|weight/i)) add('view_scan', { target: 'jezero', test: 'walk', mode: 'scan' });
  if (want3d || (!steps.length && has(q, /見せて|show/i))) add('view_3d', { on: true });
  if (wantPlay) add('view_walk', { action: 'play' });
  if (!steps.length && Object.keys(params).length === 0) return [];
  // Sliders alone: report what they mean for the current route.
  if (steps.length === 1 && steps[0].name === 'view_set_params') add('walkback_check', { lang });
  return steps;
}

/** explore_hokkaido rows, laid out in Japanese. Every value is copied from the tool's data. */
function exploreJa(r: ToolResult): string | null {
  const rows = r.data as { lat: number; lon: number; elev_m: number; slope_deg: number; score: number; near_site_ja: string | null; near_km: number | null; season_ja: string }[] | undefined;
  if (!Array.isArray(rows)) return null;
  if (!rows.length) return '条件に合う北海道の 1 km マスは見つかりませんでした。';
  const line = (x: (typeof rows)[number], i: number) =>
    `${i + 1}) ${x.near_site_ja ? `${x.near_site_ja}付近（${x.near_km} km）` : `北緯${x.lat.toFixed(2)} 東経${x.lon.toFixed(2)}`} 標高 ${Math.round(x.elev_m)} m・傾斜 ${x.slope_deg.toFixed(1)}°・スコア ${x.score.toFixed(2)}`;
  return `この歩行訓練（Jezero／歩く）に向く北海道の場所: ${rows.map(line).join('; ')}。時期: ${rows[0].season_ja}。`;
}

const HELP: Record<Lang, string> = {
  ja: 'こんな質問に答えられます: 「基地から3km先まで歩いて帰れる？」「酸素6時間なら？」「同じ坂の練習コースを北海道で探して」「この訓練、北海道のどこでいつやる？」「根拠を見せて」「3Dで歩いて見せて」。',
  en: 'Try: "Can I walk back from 3 km out?", "What if O2 is 6 hours?", "Find a practice course in Hokkaido with the same slopes", "Where and when in Hokkaido should we train?", "Show the evidence", "Show the walk in 3D".',
};

export const rulesAgent: AgentPort = {
  id: 'rules',
  label: '規則版（AIなし）',
  available: () => true,
  async ask(prompt, tools: ToolDef[], onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
    const lang = detectLang(prompt);
    const steps = plan(prompt, new Set(tools.map((t) => t.name)));
    if (!steps.length) { onEvent({ type: 'text', text: HELP[lang] }); onEvent({ type: 'done' }); return; }
    const parts: string[] = [];
    for (const s of steps) {
      if (signal?.aborted) { onEvent({ type: 'error', message: lang === 'ja' ? '中止しました' : 'Stopped' }); return; }
      const args = { ...s.args };
      const { ok, result } = await callTool(s.name, args, onEvent);
      // Show the best explore_hokkaido cell on the map (coordinates copied from that tool's result).
      if (s.name === 'explore_hokkaido' && ok) {
        const rows = result.data as { lat: number; lon: number }[] | undefined;
        if (rows?.length && tools.some((t) => t.name === 'view_scan')) {
          await callTool('view_scan', { target: 'jezero', test: 'walk', mode: 'scan', focus: { lat: rows[0].lat, lon: rows[0].lon } }, onEvent);
        }
      }
      const tool = tools.find((t) => t.name === s.name);
      if (!ok) parts.push(result.text);
      else if (tool?.kind === 'compute') parts.push(lang === 'ja' && s.name === 'explore_hokkaido' ? exploreJa(result) ?? result.text : result.text);
    }
    if (!parts.length) parts.push(lang === 'ja' ? '画面を切り替えました。' : 'Updated the view.');
    onEvent({ type: 'text', text: parts.join('\n') });
    onEvent({ type: 'done' });
  },
};
