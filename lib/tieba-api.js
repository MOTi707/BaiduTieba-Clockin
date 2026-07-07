/**
 * 百度贴吧 API 封装
 */
const TiebaAPI = (() => {
  const BASE_URL = 'https://tieba.baidu.com';

  // 通用 fetch 封装
  async function request(url, options = {}) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
      },
      ...options
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp;
  }

  async function requestJSON(url, options = {}) {
    const resp = await request(url, options);
    return resp.json();
  }

  // 获取 tbs 参数
  async function getTBS() {
    try {
      const data = await requestJSON(`${BASE_URL}/dc/common/tbs`);
      if (data && data.tbs) return data.tbs;
    } catch (e) {
      console.warn('[TiebaAPI] getTBS from /dc/common/tbs failed:', e);
    }
    // 备用：从首页获取
    try {
      const resp = await request(BASE_URL);
      const text = await resp.text();
      const match = text.match(/'tbs':\s*'([a-f0-9]+)'/);
      if (match) return match[1];
    } catch (e) {
      console.warn('[TiebaAPI] getTBS from homepage failed:', e);
    }
    throw new Error('无法获取 tbs 参数，请确认已登录百度贴吧');
  }

  // 获取关注贴吧列表（方式1：通过移动端接口）
  async function getFollowedForums_mobile() {
    const data = await requestJSON(
      `${BASE_URL}/mo/q/newmoindex?need_tab=0&need_forum=1&need_user=0`,
      { headers: { 'Referer': BASE_URL } }
    );
    if (data && data.data && data.data.like_forum) {
      return data.data.like_forum.map(forum => ({
        name: forum.forum_name,
        id: forum.forum_id,
        level: forum.user_level || '',
        isSigned: forum.is_sign === 1 || forum.is_sign === '1',
        signCount: forum.current_sign_in_count || 0
      }));
    }
    return null;
  }

  // 获取关注贴吧列表（方式2：通过关注列表页接口）
  async function getFollowedForums_list() {
    const forums = [];
    let page = 1;
    const maxPages = 20;

    while (page <= maxPages) {
      const resp = await request(
        `${BASE_URL}/f/like/mylike?pn=${page}`,
        { headers: { 'Referer': BASE_URL } }
      );
      const html = await resp.text();

      // 解析 HTML 中的贴吧列表
      const itemRegex = /<a[^>]*class="forum_name"[^>]*title="([^"]+)"[^>]*>/g;
      let match;
      let found = false;
      while ((match = itemRegex.exec(html)) !== null) {
        forums.push({ name: match[1].trim(), id: '', level: '', isSigned: false });
        found = true;
      }

      // 尝试另一种格式
      if (!found) {
        const altRegex = /title="([^"]+)"[^>]*href="\/f\?kw=([^&"]+)/g;
        while ((match = altRegex.exec(html)) !== null) {
          const name = match[1].trim();
          if (!forums.some(f => f.name === name)) {
            forums.push({ name, id: '', level: '', isSigned: false });
          }
        }
      }

      // 检查是否有下一页
      if (!html.includes('下一页') && !html.includes(`pn=${page + 1}`)) break;
      page++;
    }

    return forums.length > 0 ? forums : null;
  }

  // 获取关注贴吧列表（方式3：从首页 HTML 解析）
  async function getFollowedForums_homepage() {
    const resp = await request(BASE_URL, { headers: { 'Referer': BASE_URL } });
    const html = await resp.text();
    const forums = [];

    // 尝试从首页的"我的关注"区域解析
    const regex = /forum_name['":\s]+['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const name = match[1].trim();
      if (!forums.some(f => f.name === name)) {
        forums.push({ name, id: '', level: '', isSigned: false });
      }
    }

    return forums.length > 0 ? forums : null;
  }

  // 获取关注贴吧列表（综合，带降级策略）
  async function getFollowedForums() {
    // 方式1：移动端接口
    try {
      const forums = await getFollowedForums_mobile();
      if (forums && forums.length > 0) return forums;
    } catch (e) {
      console.warn('[TiebaAPI] Mobile API failed:', e);
    }

    // 方式2：关注列表页
    try {
      const forums = await getFollowedForums_list();
      if (forums && forums.length > 0) return forums;
    } catch (e) {
      console.warn('[TiebaAPI] List page failed:', e);
    }

    // 方式3：首页解析
    try {
      const forums = await getFollowedForums_homepage();
      if (forums && forums.length > 0) return forums;
    } catch (e) {
      console.warn('[TiebaAPI] Homepage parse failed:', e);
    }

    throw new Error('无法获取关注贴吧列表，请确认已登录百度贴吧');
  }

  // 检查单个贴吧的签到状态
  async function checkSignStatus(forumName) {
    try {
      const resp = await request(
        `${BASE_URL}/f?kw=${encodeURIComponent(forumName)}`,
        { headers: { 'Referer': BASE_URL } }
      );
      const html = await resp.text();

      // 检查是否已签到（新版界面）
      if (html.includes('已签到') || html.includes('签到成功') ||
          html.includes('signed') || html.includes('is_sign=1')) {
        return { isSigned: true };
      }

      // 尝试从页面数据中获取签到状态
      const signMatch = html.match(/is_sign['":\s]+(\d+)/);
      if (signMatch) {
        return { isSigned: parseInt(signMatch[1]) === 1 };
      }

      return { isSigned: false };
    } catch (e) {
      console.warn(`[TiebaAPI] checkSignStatus failed for ${forumName}:`, e);
      return { isSigned: false, error: e.message };
    }
  }

  // 执行签到
  async function doSign(forumName, tbs) {
    try {
      const formData = new URLSearchParams();
      formData.append('ie', 'utf-8');
      formData.append('kw', forumName);
      formData.append('tbs', tbs);

      const resp = await request(`${BASE_URL}/sign/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${BASE_URL}/f?kw=${encodeURIComponent(forumName)}`
        },
        body: formData.toString()
      });

      const data = await resp.json();

      if (data.no === 0) {
        return {
          success: true,
          forumName,
          message: '签到成功',
          data: data.data || {}
        };
      } else if (data.no === 1101) {
        // 已签到
        return {
          success: true,
          forumName,
          message: '今日已签到',
          alreadySigned: true
        };
      } else {
        return {
          success: false,
          forumName,
          message: data.error || `签到失败 (code: ${data.no})`,
          errorCode: data.no
        };
      }
    } catch (e) {
      return {
        success: false,
        forumName,
        message: `签到异常: ${e.message}`
      };
    }
  }

  // 批量签到
  async function signAll(forums, onProgress) {
    const results = [];
    let tbs;

    try {
      tbs = await getTBS();
    } catch (e) {
      return forums.map(f => ({
        success: false,
        forumName: f.name,
        message: e.message
      }));
    }

    for (let i = 0; i < forums.length; i++) {
      const forum = forums[i];
      if (onProgress) onProgress(i, forums.length, forum.name, 'signing');

      const result = await doSign(forum.name, tbs);
      results.push(result);

      if (onProgress) {
        onProgress(i + 1, forums.length, forum.name,
          result.success ? 'success' : 'failed');
      }

      // 每个贴吧之间延迟 1.5 秒，避免频率限制
      if (i < forums.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    return results;
  }

  return {
    getTBS,
    getFollowedForums,
    checkSignStatus,
    doSign,
    signAll
  };
})();

// 兼容 content script 和 service worker 环境
if (typeof window !== 'undefined') {
  window.TiebaAPI = TiebaAPI;
}
