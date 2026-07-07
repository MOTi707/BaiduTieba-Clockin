/**
 * Content Script - 注入贴吧页面
 * 用于辅助获取签到状态和 tbs 参数
 */
(() => {
  // 监听来自 popup / background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'get-tbs') {
      const tbs = getTBSFromPage();
      sendResponse({ tbs });
      return true;
    }

    if (message.type === 'get-sign-status') {
      const status = getSignStatusFromPage();
      sendResponse(status);
      return true;
    }

    if (message.type === 'get-forum-name') {
      const forumName = getForumNameFromPage();
      sendResponse({ forumName });
      return true;
    }
  });

  // 从页面获取 tbs
  function getTBSFromPage() {
    // 尝试从页面脚本中获取
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/['"]?tbs['"]?\s*[:=]\s*['"]([a-f0-9]+)['"]/);
      if (match) return match[1];
    }

    // 尝试从 window 对象获取
    if (window.PageData && window.PageData.tbs) {
      return window.PageData.tbs;
    }

    // 尝试从 meta 标签获取
    const meta = document.querySelector('meta[name="tbs"]');
    if (meta) return meta.content;

    return null;
  }

  // 从页面获取签到状态
  function getSignStatusFromPage() {
    // 新版界面签到按钮检测
    const signBtn = document.querySelector('.sign_btn, .j_signbtn, [data-daid="d0"]');
    if (signBtn) {
      const text = signBtn.textContent.trim();
      if (text.includes('已签到') || text.includes('签到成功')) {
        return { isSigned: true, element: 'button' };
      }
      return { isSigned: false, element: 'button' };
    }

    // 检查签到状态文字
    const statusEl = document.querySelector('.sign_mod_desc, .sign_keep_dialog');
    if (statusEl) {
      const text = statusEl.textContent.trim();
      return { isSigned: text.includes('已签到') || text.includes('签到成功') };
    }

    // 检查页面中是否有签到成功的提示
    const pageText = document.body.innerText;
    if (pageText.includes('签到成功') || pageText.includes('您今日已签到')) {
      return { isSigned: true };
    }

    return { isSigned: false };
  }

  // 从页面获取当前贴吧名称
  function getForumNameFromPage() {
    // 从标题获取
    const titleEl = document.querySelector('.card_title_fname, .forum_name');
    if (titleEl) return titleEl.textContent.trim();

    // 从 URL 参数获取
    const url = new URL(window.location.href);
    const kw = url.searchParams.get('kw');
    if (kw) return kw;

    return null;
  }

  // 自动上报当前页面的签到信息到 storage（可选）
  function reportPageStatus() {
    const forumName = getForumNameFromPage();
    if (!forumName) return;

    const tbs = getTBSFromPage();
    const status = getSignStatusFromPage();

    chrome.storage.local.get(['signResults'], (data) => {
      const signResults = data.signResults || {};
      if (!signResults[forumName]) {
        signResults[forumName] = {
          success: status.isSigned,
          forumName,
          message: status.isSigned ? '已签到（页面检测）' : '未签到',
          fromContentScript: true,
          tbs
        };
        chrome.storage.local.set({ signResults });
      }
    });
  }

  // 页面加载完成后自动上报
  if (document.readyState === 'complete') {
    reportPageStatus();
  } else {
    window.addEventListener('load', reportPageStatus);
  }
})();
