/**
 * 中文友好的文本切分。
 *
 * 为什么要自己切而不是按固定长度截断：中文没有空格，按字符数硬切会把
 * 「区域代理政策」拦腰切断，切出「区域代」和「理政策」两个无意义片段，
 * 向量的语义就散了。
 *
 * 三层优先级（面试可讲的核心逻辑）：
 *
 *   1. 段落边界   `\n\n` —— 天然语义单元，最优先
 *   2. 句子边界   `。！？；` —— 段落太长时退而求其次
 *   3. 长度兜底   按字符硬切 —— 只有前两层都不可用时才用
 *
 * 重叠（overlap）：相邻块共享一段文字，避免「跨块的句子」在边界处丢失上下文。
 * 默认 15%——低于 10% 起不到接续作用，高于 25% 会让检索结果大量重复。
 */

export type Chunk = {
  /** 在这篇文档里第几块（从 0 开始）。 */
  index: number;
  text: string;
  /** 用于稳定生成向量 id：同一文档版本 + 同一位置 → 同一个 id。 */
  key: string;
};

export type ChunkOptions = {
  /** 每块最多多少字符。默认 500——bge-m3 上限 8192 token，500 字足够表达一个完整意思。 */
  maxChars?: number;
  /** 相邻块重叠多少字符。默认 maxChars 的 15%。 */
  overlapChars?: number;
  /** 最短块长度，低于这个值就并入前一块（避免「见附件」这种碎片）。 */
  minChars?: number;
};

const DEFAULT_MAX_CHARS = 500;
const DEFAULT_MIN_CHARS = 40;

/**
 * 切分一篇文档。
 *
 * @param documentVersionId 用来生成稳定的 chunk key；文档改版时这个值会变，
 *                          于是旧块自然失效。
 */
export function chunkDocument(
  documentVersionId: string,
  content: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxChars = Math.max(80, options.maxChars ?? DEFAULT_MAX_CHARS);
  const minChars = Math.min(maxChars, Math.max(10, options.minChars ?? DEFAULT_MIN_CHARS));
  const overlap = Math.max(0, Math.min(options.overlapChars ?? Math.floor(maxChars * 0.15), maxChars - 1));

  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  // 第一层：按段落拆。空行是天然的语义边界。
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  // 第二层：段落超长的，按句子拆。
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length <= maxChars) {
        units.push(sentence);
        continue;
      }
      // 第三层：单句还超长（中文长句/无标点），只能按长度硬切。
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        units.push(sentence.slice(offset, offset + maxChars));
      }
    }
  }

  // 组装：贪心地把小单元拼到 maxChars 以内。
  const chunks: string[] = [];
  let buffer = "";
  for (const unit of units) {
    if (!buffer) {
      buffer = unit;
      continue;
    }
    if (buffer.length + unit.length + 1 <= maxChars) {
      buffer = `${buffer}\n${unit}`;
      continue;
    }
    chunks.push(buffer);
    // 重叠：把上一块的尾部带到下一块开头。
    buffer = overlap > 0 ? `${buffer.slice(-overlap)}${unit}` : unit;
  }
  if (buffer.trim()) chunks.push(buffer);

  // 收尾：太短的块并入前一块，减少碎片。
  const merged: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (trimmed.length < minChars && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${trimmed}`;
      continue;
    }
    merged.push(trimmed);
  }

  return merged.map((text, index) => ({
    index,
    text,
    key: `${documentVersionId}:${index}`,
  }));
}

/**
 * 按句末标点切句，标点留在句尾。
 *
 * 不用 `split(捕获组)`：不同 JS 引擎对捕获组的分隔符顺序处理不一致
 * （实测数组给出的是 ["第一句", "。第二句", "！第三句", ...]，标点跑到了
 * **下一句开头**）。改用全局正则逐段匹配，行为确定。
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const pattern = /[^。！？；\.\!\?;]+[。！？；\.\!\?;]?/g;
  for (const match of text.matchAll(pattern)) {
    const piece = match[0].trim();
    if (piece) out.push(piece);
  }
  // 正则没覆盖到的尾巴（比如纯空白）忽略即可。
  return out;
}
