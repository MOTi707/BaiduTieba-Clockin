/**
 * 弹窗主逻辑
 */
document.addEventListener('DOMContentLoaded', async () => {
  const forumListEl = document.getElementById('forum-list');
  const statusTextEl = document.getElementById('status-text');
  const signCountEl = document.getElementById('sign-count');
  const btnSignAll = document.getElementById('btn-sign-all');
  const btnRefresh = document.getElementById('btn-refresh');
  const lastSignTimeEl = document.getElementById('last-sign-time');

  let forums = [];
  let signResults = {};  // { forumName: { success, message, ... } }
  let isSigning = false;

  // 初始化：加载数据
  await initData();

  // 绑定事件
  btnSignAll.addEventListener('click', handleSignAll);
  btnRefresh.addEventListener('click', handleRefresh);

  // 加载完成后自动触发签到
  await autoStartSign();

  // 加载数据
  async function initData() {
    showLoading();
    try {
      const today = new Date().toDateString();

      // 先从 storage 读取缓存的签到结果
      const storageData = await chrome.storage.local.get(['forums', 'signResults', 'lastSignTime']);

      if (storageData.signResults) {
        signResults = storageData.signResults;
      }

      if (storageData.lastSignTime) {
        const lastDate = new Date(storageData.lastSignTime).toDateString();
        if (lastDate === today) {
          lastSignTimeEl.textContent = `上次签到: ${formatTime(storageData.lastSignTime)}`;
        } else {
          lastSignTimeEl.textContent = '今日尚未签到';
        }
      } else {
        lastSignTimeEl.textContent = '今日尚未签到';
      }

      // 获取关注列表
      forums = await TiebaAPI.getFollowedForums();

      if (!forums || forums.length === 0) {
        showEmpty();
        return;
      }

      // 合并签到状态（只保留今天的签到记录）
      forums = forums.map(f => {
        const r = signResults[f.name];
        const isTodayResult = r && r.signTime && new Date(r.signTime).toDateString() === today;
        let status;
        if (isTodayResult) {
          status = r.success ? 'signed' : 'failed';
        } else if (f.isSigned) {
          status = 'signed';
        } else {
          status = 'unsigned';
        }
        return {
          ...f,
          status,
          result: isTodayResult ? r : null
        };
      });

      renderForumList();
      updateStatusBar();

      // 保存到 storage
      await chrome.storage.local.set({ forums });

    } catch (e) {
      console.error('[Popup] initData error:', e);
      showError(e.message);
    }
  }

  // 渲染贴吧列表
  function renderForumList() {
    forumListEl.innerHTML = '';

    forums.forEach((forum, index) => {
      const item = document.createElement('div');
      item.className = 'forum-item';
      item.dataset.index = index;

      const statusClass = `status-${forum.status || 'unsigned'}`;
      const statusText = getStatusText(forum.status, forum.result);

      item.innerHTML = `
        <div class="forum-info">
          <div class="forum-name" title="${escapeHtml(forum.name)}">${escapeHtml(forum.name)}</div>
          ${forum.level ? `<div class="forum-level">等级: ${forum.level}</div>` : ''}
        </div>
        <div class="forum-status">
          <span class="status-badge ${statusClass}">${statusText}</span>
          ${(forum.status === 'failed' || forum.status === 'unsigned') ? `
            <button class="btn btn-retry" data-index="${index}" title="单独签到">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
          ` : ''}
        </div>
      `;

      forumListEl.appendChild(item);
    });

    // 绑定单独签到按钮
    forumListEl.querySelectorAll('.btn-retry').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        handleSingleSign(idx);
      });
    });
  }

  // 打开弹窗时自动触发签到
  async function autoStartSign() {
    const unsignedForums = forums.filter(f => f.status === 'unsigned' || f.status === 'failed');
    if (unsignedForums.length === 0) {
      statusTextEl.textContent = '所有贴吧已签到！';
      return;
    }

    // 自动开始签到
    await handleSignAll();
  }

  // 一键签到
  async function handleSignAll() {
    if (isSigning) return;

    const unsignedForums = forums.filter(f => f.status === 'unsigned' || f.status === 'failed');
    if (unsignedForums.length === 0) {
      statusTextEl.textContent = '所有贴吧已签到！';
      return;
    }

    isSigning = true;
    btnSignAll.disabled = true;
    btnSignAll.textContent = '签到中...';

    const total = unsignedForums.length;
    let signed = 0;
    let failed = 0;

    for (let i = 0; i < unsignedForums.length; i++) {
      const forum = unsignedForums[i];
      const forumIndex = forums.indexOf(forum);

      // 更新状态为签到中
      forums[forumIndex].status = 'signing';
      updateForumItem(forumIndex);
      statusTextEl.textContent = `签到中 (${i + 1}/${total}): ${forum.name}`;

      // 执行签到
      try {
        const tbs = await TiebaAPI.getTBS();
        const result = await TiebaAPI.doSign(forum.name, tbs);

        signResults[forum.name] = { ...result, signTime: Date.now() };
        forums[forumIndex].result = signResults[forum.name];

        if (result.success) {
          forums[forumIndex].status = 'signed';
          signed++;
        } else {
          forums[forumIndex].status = 'failed';
          failed++;
        }
      } catch (e) {
        forums[forumIndex].status = 'failed';
        forums[forumIndex].result = { success: false, message: e.message, signTime: Date.now() };
        signResults[forum.name] = forums[forumIndex].result;
        failed++;
      }

      updateForumItem(forumIndex);
      updateStatusBar();

      // 延迟 1.5 秒
      if (i < unsignedForums.length - 1) {
        await sleep(1500);
      }
    }

    // 签到完成
    isSigning = false;
    btnSignAll.disabled = false;
    btnSignAll.textContent = '一键签到';

    const now = Date.now();
    lastSignTimeEl.textContent = `上次签到: ${formatTime(now)}`;

    await chrome.storage.local.set({
      signResults,
      lastSignTime: now,
      forums
    });

    statusTextEl.textContent = `签到完成: 成功 ${signed} 个${failed > 0 ? `, 失败 ${failed} 个` : ''}`;
  }

  // 单独签到某个贴吧
  async function handleSingleSign(index) {
    const forum = forums[index];
    if (!forum) return;

    forums[index].status = 'signing';
    updateForumItem(index);

    try {
      const tbs = await TiebaAPI.getTBS();
      const result = await TiebaAPI.doSign(forum.name, tbs);

      signResults[forum.name] = { ...result, signTime: Date.now() };
      forums[index].result = signResults[forum.name];
      forums[index].status = result.success ? 'signed' : 'failed';
    } catch (e) {
      forums[index].status = 'failed';
      forums[index].result = { success: false, message: e.message, signTime: Date.now() };
      signResults[forum.name] = forums[index].result;
    }

    updateForumItem(index);
    updateStatusBar();

    await chrome.storage.local.set({ signResults, forums });
  }

  // 刷新
  async function handleRefresh() {
    if (isSigning) return;
    signResults = {};
    await chrome.storage.local.remove(['signResults', 'lastSignTime']);
    await initData();
  }

  // 更新单个贴吧项的显示
  function updateForumItem(index) {
    const item = forumListEl.querySelector(`[data-index="${index}"]`);
    if (!item) return;

    const forum = forums[index];
    const statusClass = `status-${forum.status || 'unsigned'}`;
    const statusText = getStatusText(forum.status, forum.result);

    const badge = item.querySelector('.status-badge');
    if (badge) {
      badge.className = `status-badge ${statusClass}`;
      badge.textContent = statusText;
    }

    // 更新重试按钮
    const retryBtn = item.querySelector('.btn-retry');
    if (retryBtn && (forum.status === 'signed' || forum.status === 'signing')) {
      retryBtn.remove();
    } else if (!retryBtn && (forum.status === 'unsigned' || forum.status === 'failed')) {
      const statusEl = item.querySelector('.forum-status');
      const btn = document.createElement('button');
      btn.className = 'btn btn-retry';
      btn.dataset.index = index;
      btn.title = '单独签到';
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSingleSign(index);
      });
      statusEl.appendChild(btn);
    }
  }

  // 更新状态栏
  function updateStatusBar() {
    const signed = forums.filter(f => f.status === 'signed').length;
    const total = forums.length;
    signCountEl.textContent = `已签 ${signed}/${total}`;
  }

  // 显示加载状态
  function showLoading() {
    forumListEl.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>正在加载关注贴吧...</p>
      </div>
    `;
    statusTextEl.textContent = '加载中...';
    signCountEl.textContent = '';
  }

  // 显示空状态
  function showEmpty() {
    forumListEl.innerHTML = `
      <div class="empty-state">
        <p>暂无关注的贴吧</p>
        <a href="https://tieba.baidu.com" target="_blank">前往百度贴吧</a>
      </div>
    `;
    statusTextEl.textContent = '暂无关注贴吧';
    signCountEl.textContent = '';
  }

  // 显示错误状态
  function showError(message) {
    forumListEl.innerHTML = `
      <div class="error-state">
        <p>${escapeHtml(message)}</p>
        <p>请确保已登录 <a href="https://tieba.baidu.com" target="_blank">百度贴吧</a></p>
        <button class="btn" onclick="location.reload()">重试</button>
      </div>
    `;
    statusTextEl.textContent = '加载失败';
    signCountEl.textContent = '';
  }

  // 工具函数
  function getStatusText(status, result) {
    switch (status) {
      case 'signed': return result?.alreadySigned ? '已签过' : '已签到';
      case 'signing': return '签到中';
      case 'failed': return '失败';
      default: return '未签到';
    }
  }

  function formatTime(timestamp) {
    const d = new Date(timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
});
