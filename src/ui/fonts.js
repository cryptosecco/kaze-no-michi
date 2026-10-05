// The typefaces come from Google Fonts (<link> in index.html). Japanese faces are served in unicode-range
// slices, so we explicitly request the glyphs the UI paints; captures wait (bounded) so text never
// renders in a fallback face.

const BRUSH_TEXT = '風の道旅対峙終散続き新たな旅設定制作再開写真表題へ戻る秋暮地図';

export async function loadFonts(timeoutMs = 3500) {
  if (!document.fonts || !document.fonts.load) return false;
  const jobs = [
    document.fonts.load('400 96px "Yuji Boku"', BRUSH_TEXT),
    document.fonts.load('400 18px "Shippori Mincho"', 'この道や行く人なしに秋の暮れ新たな旅続き設定制作再開写真表題へ戻る地図'),
    document.fonts.load('500 18px "Shippori Mincho"', '風の道地図'),
    document.fonts.load('300 18px "Cormorant Garamond"', 'KAZE NO MICHI'),
    document.fonts.load('400 18px "Cormorant Garamond"', 'Abc'),
    document.fonts.load('500 18px "Cormorant Garamond"', 'Abc'),
    document.fonts.load('600 18px "Cormorant Garamond"', 'Abc'),
    document.fonts.load('italic 400 18px "Cormorant Garamond"', 'Abc'),
  ];
  let timer;
  const timeout = new Promise((r) => (timer = setTimeout(() => r(false), timeoutMs)));
  const ok = await Promise.race([Promise.allSettled(jobs).then(() => true), timeout]);
  clearTimeout(timer);
  return ok;
}
