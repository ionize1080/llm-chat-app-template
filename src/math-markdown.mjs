import { Marked } from "marked";
import katex from "katex";

const htmlEscape = value => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function escapedAt(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === "\\") count++;
  return count % 2 === 1;
}

function mathToken(source, block = false) {
  const indent = block ? (source.match(/^ {0,3}/)?.[0].length || 0) : 0;
  const text = source.slice(indent);
  let left, right, display;
  if (text.startsWith("$$")) { left = right = "$$"; display = true; }
  else if (text.startsWith("\\[")) { left = "\\["; right = "\\]"; display = true; }
  else if (!block && text.startsWith("\\(")) { left = "\\("; right = "\\)"; display = false; }
  else if (!block && text.startsWith("$") && !/\s|\$/.test(text[1] || " ")) { left = right = "$"; display = false; }
  else return;

  let closing = text.indexOf(right, left.length);
  while (closing >= 0 && escapedAt(text, closing)) closing = text.indexOf(right, closing + right.length);
  if (left === "$") {
    // A single dollar is also a currency sign. Never cross lines or consume a
    // later formula past an invalid first closing dollar (e.g. "$5 and $10").
    if (closing < 0 || /[\r\n]/.test(text.slice(1, closing)) ||
        /\s/.test(text[closing - 1]) || /[\d$]/.test(text[closing + 1] || "")) return;
  }
  if (closing < 0) {
    // Keep explicit, unfinished math literal during streaming. The full source
    // is re-lexed on every paint, so the final delimiter completes it normally.
    return {type: block ? "veaixMathBlock" : "veaixMathInline", raw: source,
      text: source, pending: true, display};
  }
  const raw = source.slice(0, indent + closing + right.length);
  const tex = text.slice(left.length, closing);
  if (!tex.trim()) return;
  return {type:block ? "veaixMathBlock" : "veaixMathInline", raw, text:tex.trim(), display};
}

function protectTablePipes(source) {
  // GFM splits table cells before running inline extensions. Hide only pipes
  // inside complete math spans until the inline math tokenizer can own them.
  let marker = "\uE000VEAIX_PIPE\uE001";
  while (source.includes(marker)) marker += "\uE001";
  const pieces = [];
  let cursor = 0, plain = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "`") {
      const run = /^`+/.exec(source.slice(cursor))[0];
      let end = source.indexOf(run, cursor + run.length);
      while (end >= 0 && (source[end - 1] === "`" || source[end + run.length] === "`"))
        end = source.indexOf(run, end + run.length);
      if (end >= 0) { cursor = end + run.length; continue; }
    }
    if (char === "<") {
      const tag = /^<(code|pre|script|style|textarea)\b[^>]*>/i.exec(source.slice(cursor));
      if (tag) {
        const end = new RegExp(`</${tag[1]}\\s*>`,"i").exec(source.slice(cursor + tag[0].length));
        cursor = end ? cursor + tag[0].length + end.index + end[0].length : source.length;
        continue;
      }
    }
    if ((char === "$" || char === "\\") && !escapedAt(source,cursor)) {
      const token = mathToken(source.slice(cursor));
      if (token && !token.pending) {
        if (token.raw.includes("|")) {
          pieces.push(source.slice(plain,cursor),token.raw.replaceAll("|",marker));
          plain = cursor + token.raw.length;
        }
        cursor += token.raw.length;
        continue;
      }
    }
    cursor++;
  }
  pieces.push(source.slice(plain));
  return {source:pieces.join(""),marker};
}

/** Protect LaTeX before Markdown can consume backslashes, underscores or stars.
 * The returned HTML is untrusted Markdown and MUST be sanitized by the caller.
 * Formula contents are kept out of that HTML, in a separate local registry.
 */
export function parseMathMarkdown(source) {
  const protectedText = protectTablePipes(String(source));
  const math = [];
  const renderer = token => {
    if (token.pending) return `<span class="math-pending">${htmlEscape(token.text)}</span>`;
    const index = math.push({tex:token.text.replaceAll(protectedText.marker,"|"),display:token.display}) - 1;
    const tag = token.type === "veaixMathBlock" ? "div" : "span";
    return `<${tag} data-veaix-math="${index}"></${tag}>`;
  };
  const markdown = new Marked({gfm:true});
  markdown.use({extensions:[
    {name:"veaixMathBlock",level:"block",start(src) { const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(src); return match?.index; },
      tokenizer(src) {return mathToken(src,true);},renderer},
    {name:"veaixMathInline",level:"inline",start(src) { const match = /\$|\\[([]/.exec(src); return match?.index; },
      tokenizer(src) {if (!this.lexer.state.inRawBlock) return mathToken(src,false);},renderer},
  ]});
  return {html:markdown.parse(protectedText.source).replaceAll(protectedText.marker,"|"),math};
}

/** Called only after Markdown sanitization; KaTeX itself produces this markup.
 * No user-defined trusted URLs/HTML, shared macros or unbounded expansion.
 */
export function renderMathHTML(formula) {
  if (!formula || typeof formula.tex !== "string") return "";
  return katex.renderToString(formula.tex, {
    displayMode:!!formula.display,
    throwOnError:false,
    trust:false,
    strict:"ignore",
    maxExpand:1000,
    maxSize:20,
    macros:{},
    output:"htmlAndMathml",
  });
}
