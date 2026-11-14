import { describe, expect, it } from 'vitest';
import { extractKm, extractParams, plan } from './rules';

const ALL = new Set(['walkback_check', 'open_evidence', 'explore_hokkaido', 'view_scan', 'view_3d', 'view_overlay', 'view_set_params', 'view_walk']);
const names = (q: string) => plan(q, ALL).map((s) => s.name);

describe('rules agent routing', () => {
  it('maps the five example questions to tools', () => {
    expect(plan('基地から3km先まで歩いて帰れる？', ALL)).toEqual([{ name: 'walkback_check', args: { lang: 'ja', route: { away_km: 3 } } }]);
    expect(names('同じ坂の練習コースを北海道で探して')).toEqual(['walkback_check', 'view_overlay']);
    expect(names('この訓練、北海道のどこでいつやる？')).toEqual(['explore_hokkaido']);
    expect(names('根拠を見せて')).toEqual(['open_evidence', 'open_evidence', 'open_evidence']);
    expect(names('3Dで歩いて見せて')).toEqual(['walkback_check', 'view_3d', 'view_walk']);
  });
  it('takes numbers only from the question', () => {
    expect(extractParams('酸素6時間、冷却水5時間、速さ3km/hで余裕10%')).toEqual({ o2_h: 6, water_h: 5, speed_kmh: 3, reserve: 10 });
    expect(extractParams('Can I walk back with 6 hours of oxygen?')).toEqual({ o2_h: 6 });
    expect(extractKm('速さ3km/hで')).toBeUndefined();
    expect(extractKm('５ｋｍ先')).toBeUndefined(); // full-width digits are normalised in plan(), not here
    expect(plan('５km先まで帰れる？', ALL)[0].args.route).toEqual({ away_km: 5 });
  });
  it('bare ground and season keywords', () => {
    expect(plan('火山っぽい裸地で訓練するならどこ？', ALL)[0].args).toMatchObject({ bare_only: true });
    expect(names('冬の様子を見せて')).toEqual(['view_scan']);
    expect(plan('こんにちは', ALL)).toEqual([]);
  });
});
