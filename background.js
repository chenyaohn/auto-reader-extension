/* 自动阅读助手 · 后台脚本：把快捷键命令转发给当前标签页的内容脚本 */

const COMMAND_MAP = {
  'toggle-scroll': 'toggle',
  'speed-up': 'speedUp',
  'speed-down': 'speedDown',
  'scroll-top': 'scrollTop'
};

/* 让内容脚本也能读写 session（只用来记录「正在阅读」状态，浏览器关闭即清空） */
function allowSessionAccess() {
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    /* 旧版本 Chrome 不支持时忽略 */
  }
}

allowSessionAccess();
chrome.runtime.onStartup.addListener(allowSessionAccess);
chrome.runtime.onInstalled.addListener(allowSessionAccess);

chrome.commands.onCommand.addListener(async (command) => {
  const cmd = COMMAND_MAP[command];
  if (!cmd) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'AR_CMD', cmd });
  } catch (e) {
    /* 页面上没有内容脚本（如 chrome:// 页面），静默忽略 */
  }
});
