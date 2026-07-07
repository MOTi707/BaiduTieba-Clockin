/**
 * Service Worker - 后台定时签到
 */

// 安装时设置定时任务
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] 贴吧签到助手已安装');

  // 每小时检查一次，自动签到未签到的贴吧
  chrome.alarms.create('hourly-sign', {
    periodInMinutes: 60
  });

  // 初始化 storage
  chrome.storage.local.set({
    autoSignEnabled: true,
    lastAutoSignDate: null
  });
});

// 定时任务触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'hourly-sign') {
    await checkAndAutoSign();
  }
});

// 检查并执行自动签到
async function checkAndAutoSign() {
  const storage = await chrome.storage.local.get(['autoSignEnabled']);

  if (!storage.autoSignEnabled) return;

  console.log('[Background] 开始检查并执行自动签到...');

  try {
    // 获取关注列表
    const forums = await getFollowedForums();
    if (!forums || forums.length === 0) {
      console.log('[Background] 无关注贴吧，跳过');
      return;
    }

    // 获取已签到结果，过滤掉今天已经签到的
    const existingResults = (await chrome.storage.local.get(['signResults'])).signResults || {};
    const today = new Date().toDateString();
    const unsignedForums = forums.filter(f => {
      const r = existingResults[f.name];
      // 如果今天已经成功签到过，跳过
      if (r && r.success && r.signTime && new Date(r.signTime).toDateString() === today) {
        return false;
      }
      return !f.isSigned;
    });

    if (unsignedForums.length === 0) {
      console.log('[Background] 所有贴吧已签到，跳过');
      return;
    }

    // 获取 tbs
    const tbs = await getTBS();

    // 逐个签到
    const signResults = { ...existingResults };
    let signedCount = 0;
    let failedCount = 0;

    for (const forum of unsignedForums) {
      try {
        const result = await doSign(forum.name, tbs);
        result.signTime = Date.now();
        signResults[forum.name] = result;
        if (result.success) signedCount++;
        else failedCount++;
      } catch (e) {
        signResults[forum.name] = { success: false, message: e.message, signTime: Date.now() };
        failedCount++;
      }

      // 延迟 1.5 秒
      await sleep(1500);
    }

    // 保存结果
    await chrome.storage.local.set({
      signResults,
      lastSignTime: Date.now(),
      forums
    });

    console.log(`[Background] 自动签到完成: 成功 ${signedCount}, 失败 ${failedCount}`);

    // 发送通知
    chrome.notifications.create('sign-complete', {
      type: 'basic',
      title: '贴吧签到助手',
      message: `自动签到完成！成功 ${signedCount} 个${failedCount > 0 ? `，失败 ${failedCount} 个` : ''}`,
      silent: false
    });

  } catch (e) {
    console.error('[Background] 自动签到失败:', e);
  }
}

// === 内联 API 方法（Service Worker 无法直接访问 content script 的 TiebaAPI） ===

async function fetchJSON(url, options = {}) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'application/json, text/plain, */*' },
    ...options
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function getTBS() {
  try {
    const data = await fetchJSON('https://tieba.baidu.com/dc/common/tbs');
    if (data?.tbs) return data.tbs;
  } catch (e) {}

  // 备用：从首页获取
  const resp = await fetch('https://tieba.baidu.com/', { credentials: 'include' });
  const text = await resp.text();
  const match = text.match(/'tbs':\s*'([a-f0-9]+)'/);
  if (match) return match[1];

  throw new Error('无法获取 tbs');
}

async function getFollowedForums() {
  // 方式1：移动端接口
  try {
    const data = await fetchJSON('https://tieba.baidu.com/mo/q/newmoindex?need_tab=0&need_forum=1&need_user=0');
    if (data?.data?.like_forum) {
      return data.data.like_forum.map(f => ({
        name: f.forum_name,
        id: f.forum_id,
        isSigned: f.is_sign === 1 || f.is_sign === '1'
      }));
    }
  } catch (e) {}

  // 方式2：关注列表页
  try {
    const resp = await fetch('https://tieba.baidu.com/f/like/mylike?pn=1', { credentials: 'include' });
    const html = await resp.text();
    const forums = [];
    const regex = /title="([^"]+)"[^>]*href="\/f\?kw=/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      forums.push({ name: m[1].trim(), id: '', isSigned: false });
    }
    if (forums.length > 0) return forums;
  } catch (e) {}

  return null;
}

async function doSign(forumName, tbs) {
  const formData = new URLSearchParams();
  formData.append('ie', 'utf-8');
  formData.append('kw', forumName);
  formData.append('tbs', tbs);

  const resp = await fetch('https://tieba.baidu.com/sign/add', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://tieba.baidu.com/f?kw=${encodeURIComponent(forumName)}`
    },
    body: formData.toString()
  });

  const data = await resp.json();

  if (data.no === 0) {
    return { success: true, forumName, message: '签到成功' };
  } else if (data.no === 1101) {
    return { success: true, forumName, message: '已签到', alreadySigned: true };
  } else {
    return { success: false, forumName, message: data.error || `失败 (${data.no})` };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'trigger-sign') {
    checkAndAutoSign().then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
});
