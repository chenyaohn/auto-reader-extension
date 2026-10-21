/* 静态检查：content.js 里用到的选择器 / data-key 是否都存在于 Shadow DOM 模板中 */
const fs = require('fs');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');
const start = src.indexOf('root.innerHTML = `');
const end = src.indexOf('`;', start);
const template = src.slice(start + 'root.innerHTML = `'.length, end);
const code = src.slice(0, start) + src.slice(end);

function collect(re, text, group = 1) {
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[group]);
  return [...out];
}

const selectors = collect(/root\.querySelector(?:All)?\(\s*'([^']+)'/g, code);
const needed = [];
for (const sel of selectors) {
  // 逐个属性选择器组合拆开检查
  const parts = sel.match(/(\[[^\]]+\]|[.#][\w-]+|\b[a-z][\w-]*\b)/g) || [];
  for (const part of parts) {
    let ok = true;
    if (part.startsWith('.')) {
      ok = template.includes(`class="${part.slice(1)}`) || template.includes(` ${part.slice(1)}"`) || template.includes(`class="${part.slice(1)} `) || new RegExp(`class="[^"]*\\b${part.slice(1)}\\b`).test(template);
    } else if (part.startsWith('[')) {
      const attr = part.slice(1, -1).replace(/"/g, '');
      const [name, value] = attr.split('=');
      ok = value
        ? new RegExp(`${name}="${value}"`).test(template)
        : new RegExp(`\\b${name}\\b`).test(template);
    } else {
      ok = template.includes(`<${part}`);
    }
    if (!ok) needed.push(`${sel}  ->  缺少 ${part}`);
  }
}

// 检查 data-key 是否与状态字段匹配
const keys = collect(/data-key="([^"]+)"/g, template);
const defaultsBlock = src.slice(src.indexOf('const DEFAULTS'), src.indexOf('const SESSION_DEFAULTS'));
const stateKeys = [...new Set((defaultsBlock.match(/^\s*(\w+):/gm) || []).map((line) => line.trim().replace(':', '')))];
const missingKeys = keys.filter((k) => !stateKeys.includes(k));

console.log('querySelector 列表:', selectors.join(' | '));
console.log('模板中的 data-key:', keys.join(', '));
console.log('状态字段:', stateKeys.join(', '));
if (needed.length) console.log('❌ 缺失元素:\n' + needed.join('\n'));
if (missingKeys.length) console.log('❌ data-key 无对应状态字段:', missingKeys.join(', '));
if (!needed.length && !missingKeys.length) console.log('✅ 选择器与状态字段检查通过');
