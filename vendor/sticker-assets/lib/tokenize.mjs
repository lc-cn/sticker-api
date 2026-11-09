// 分词 zh-bigram-v1：索引与查询共用，B 必须原样使用（vendoring），不得改写。
export const TOKENIZER = 'zh-bigram-v1';
export const MAX_WHOLE_TERM = 24;

const SEP = /[\p{P}\p{S}\p{Z}\p{C}\s]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').toLowerCase().replace(SEP, ' ').trim();
}

/**
 * 分析文本 → Map(term → 'whole' | 'part')
 * whole：规范化后按空白切出的整段（≤24 码点）；part：段内 CJK 二字 gram / 单字 run、非 CJK 的字母数字 run。
 */
export function analyze(text) {
  const out = new Map();
  const norm = normalize(text);
  if (!norm) return out;
  for (const seg of norm.split(' ')) {
    if (!seg) continue;
    const chars = [...seg];
    if (chars.length <= MAX_WHOLE_TERM) out.set(seg, 'whole');
    // 切 run
    let run = [];
    let runCjk = null;
    const flush = () => {
      if (!run.length) return;
      if (runCjk) {
        if (run.length === 1) add(out, run[0]);
        else for (let i = 0; i + 1 < run.length; i++) add(out, run[i] + run[i + 1]);
      } else {
        const w = run.join('');
        if (run.length <= MAX_WHOLE_TERM) add(out, w);
      }
      run = [];
    };
    for (const ch of chars) {
      const isCjk = CJK.test(ch);
      if (runCjk !== null && isCjk !== runCjk) flush();
      runCjk = isCjk;
      run.push(ch);
    }
    flush();
  }
  return out;
}

function add(map, term) { if (!map.has(term)) map.set(term, 'part'); }

/** 查询词：与 analyze 相同，返回去重数组（保持出现顺序） */
export function queryTerms(q) { return [...analyze(q).keys()]; }
