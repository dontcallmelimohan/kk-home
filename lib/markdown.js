'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let out = escapeHtml(text);

  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
    if (!/^(https?:\/\/|\/|\.\/)/i.test(src)) return m;
    return '<img src="' + src + '" alt="' + alt + '" loading="lazy">';
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (/^javascript:/i.test(href)) return m;
    if (!/^(https?:\/\/|\/|#|mailto:|\.\/)/i.test(href)) return m;
    const ext = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
    return '<a href="' + href + '"' + ext + '>' + label + '</a>';
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => '<code>' + codes[Number(i)] + '</code>');

  return out.replace(/\n/g, '<br>\n');
}

const BLANK = /^\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*(\d+)[.)]\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const H = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const INDENTED = /^( {2,}|\t+)(.*)$/;

function render(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join('\n')) + '</p>');
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const lang = fence[2] || '';
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        buf.push(lines[i]);
        i++;
      }
      out.push(
        '<pre><code' +
          (lang ? ' class="lang-' + escapeHtml(lang) + '"' : '') +
          '>' +
          escapeHtml(buf.join('\n')) +
          '</code></pre>'
      );
      continue;
    }

    if (BLANK.test(line)) {
      flushPara();
      continue;
    }

    if (HR.test(line)) {
      flushPara();
      out.push('<hr>');
      continue;
    }

    const h = line.match(H);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length + 1, 6);
      out.push('<h' + level + '>' + inline(h[2].trim()) + '</h' + level + '>');
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (!BLANK.test(lines[i]) && buf.length))) {
        const m = lines[i].match(QUOTE);
        buf.push(m ? m[1] : lines[i].trim());
        i++;
      }
      i--;
      out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
      continue;
    }

    if (UL.test(line) || INDENTED.test(line)) {
      flushPara();
      const buf = [];
      const baseIndent = UL.test(line) ? 0 : 2;
      let cur = null;
      while (i < lines.length) {
        const m = lines[i].match(UL);
        if (m) {
          if (cur) buf.push(cur.join('\n'));
          cur = [m[1]];
          i++;
          continue;
        }
        const ind = lines[i].match(INDENTED);
        if (ind && cur) {
          cur.push(ind[2]);
          i++;
          continue;
        }
        break;
      }
      if (cur) buf.push(cur.join('\n'));
      i--;
      out.push(
        '<ul>' +
          buf.map((t) => '<li>' + inline(t.trim()) + '</li>').join('') +
          '</ul>'
      );
      void baseIndent;
      continue;
    }

    const ol = line.match(OL);
    if (ol) {
      flushPara();
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const m = lines[i].match(OL);
        if (m) {
          if (cur) items.push(cur.join('\n'));
          cur = [m[2]];
          i++;
          continue;
        }
        const ind = lines[i].match(INDENTED);
        if (ind && cur) {
          cur.push(ind[2]);
          i++;
          continue;
        }
        break;
      }
      if (cur) items.push(cur.join('\n'));
      i--;
      out.push(
        '<ol>' + items.map((t) => '<li>' + inline(t.trim()) + '</li>').join('') + '</ol>'
      );
      continue;
    }

    para.push(line.trim());
  }

  flushPara();
  return out.join('\n');
}

function plainText(src) {
  return String(src == null ? '' : src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readingMinutes(src) {
  const text = plainText(src).replace(/\s/g, '');
  return Math.max(1, Math.round(text.length / 400));
}

function excerpt(src, max) {
  const t = plainText(src);
  const limit = max || 90;
  return t.length > limit ? t.slice(0, limit) + '…' : t;
}

module.exports = { render, escapeHtml, plainText, readingMinutes, excerpt };
