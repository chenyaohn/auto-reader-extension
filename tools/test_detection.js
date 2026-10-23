/* 正文识别单元测试：用模拟 DOM 验证打分规则（不依赖浏览器） */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const constStart = src.indexOf('  /* 正文识别参数');
const constEnd = src.indexOf('  const DEFAULTS = {');
const fnStart = src.indexOf('/* ------------------------------------------------------------ 正文识别 */');
const fnEnd = src.indexOf('/* -------------------------------------------------------------------- UI */');

if (constStart < 0 || fnStart < 0 || fnEnd < 0) {
  throw new Error('无法从 content.js 中定位正文识别代码');
}

const snippet = src.slice(constStart, constEnd) + '\n' + src.slice(fnStart, fnEnd);

function element({ text = '', linkText = '', links = 0, paragraphs = 0, className = '', id = '' }) {
  return {
    className,
    id,
    innerText: text + linkText,
    textContent: text + linkText,
    querySelectorAll(sel) {
      if (sel === 'a') {
        const each = links ? Math.floor(linkText.length / links) : 0;
        return Array.from({ length: links }, () => ({ textContent: '字'.repeat(each) }));
      }
      if (sel === 'p') return Array.from({ length: paragraphs }, () => ({}));
      return [];
    }
  };
}

function makeDocument({ candidates = [], body, ogType = '', headHtml = '' }) {
  return {
    body,
    head: { innerHTML: headHtml },
    querySelectorAll() { return candidates; },
    querySelector() {
      if (!ogType) return null;
      return { getAttribute: () => ogType };
    }
  };
}

function run(doc) {
  const factory = new Function('document', `${snippet}\nreturn { detectArticle, scoreArticleBlock };`);
  return factory(doc);
}

const prose = '她端起茶杯，轻轻吹了吹热气。'.repeat(150); // 约 2250 字

const cases = [
  {
    name: '起点章节页（.read-content，2200+ 字）',
    doc: makeDocument({
      candidates: [element({ text: prose, links: 2, linkText: '上一章下一章目录', paragraphs: 40, className: 'read-content', id: 'j_readContent' })],
      body: element({ text: prose, links: 2, linkText: '上一章下一章目录', paragraphs: 40 })
    }),
    expect: true
  },
  {
    name: '新闻正文（article 标签，600 字）',
    doc: makeDocument({
      candidates: [element({ text: prose.slice(0, 600), links: 3, linkText: '相关阅读更多新闻', paragraphs: 8, className: 'article-body' })],
      body: element({ text: prose.slice(0, 600), paragraphs: 8 })
    }),
    expect: true
  },
  {
    name: '首页 / 列表页（大量链接）',
    doc: makeDocument({
      candidates: [element({ text: '标题一，标题二。'.repeat(60), links: 120, linkText: '标题一，标题二。'.repeat(120), paragraphs: 4, className: 'content list-nav' })],
      body: element({ text: '标题一，标题二。'.repeat(120), links: 120, linkText: '标题一，标题二。'.repeat(120), paragraphs: 4 })
    }),
    expect: false
  },
  {
    name: '短页面（200 字）',
    doc: makeDocument({
      candidates: [element({ text: prose.slice(0, 200), paragraphs: 2, className: 'content' })],
      body: element({ text: prose.slice(0, 200), paragraphs: 2 })
    }),
    expect: false
  },
  {
    name: '无语义标签的长文（兜底判断）',
    doc: makeDocument({
      candidates: [],
      body: element({ text: prose, links: 5, linkText: '首页上一页下一页', paragraphs: 30 })
    }),
    expect: true
  },
  {
    name: 'og:type=article 的正文',
    doc: makeDocument({
      candidates: [element({ text: prose.slice(0, 450), paragraphs: 5, className: 'main' })],
      body: element({ text: prose.slice(0, 450), paragraphs: 5 }),
      ogType: 'article'
    }),
    expect: true
  }
];

let failed = 0;
for (const testCase of cases) {
  const api = run(testCase.doc);
  const actual = api.detectArticle();
  const ok = actual === testCase.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${testCase.name} -> ${actual ? '显示悬浮条' : '不显示'}`);
}

if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\n全部用例通过');
