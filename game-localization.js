(() => {
  const open = document.getElementById('gameLocalization');
  const dialog = document.getElementById('gameLocalizationDialog');
  const install = document.getElementById('gameLocalizationInstall');
  const notice = document.getElementById('gameLocalizationStatus');

  const messages = {
    installed: '已汉化（最新版）',
    outdated: '检测到旧版自制汉化，可以直接更新。',
    busy: '正在处理游戏文件，请稍候。',
    'game-open': '请先退出游戏，再试一次。',
    unsupported: '当前游戏文件暂不支持一键汉化。',
    'no-space': '游戏所在磁盘空间不足。',
    failed: '操作失败，可下载运行日志查看原因。'
  };
  let state;
  let feedback;
  let pending = false;

  function render() {
    open.hidden = !state || state === 'unavailable';
    open.disabled = pending || state === 'installed';
    open.textContent = t(state === 'installed' ? '已汉化（最新版）' : state === 'outdated' ? '更新自制汉化' : '一键汉化');
    install.disabled = pending || !['available', 'outdated'].includes(state);
    install.textContent = t(state === 'installed' ? '已汉化（最新版）' : state === 'outdated' ? '更新自制汉化' : '安装自制汉化');
    notice.textContent = feedback ? t(messages[feedback] ?? '') : '';
  }

  async function request(action) {
    const response = await fetch('game-localization/' + action, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { 'x-calculator-game-localization': '1' }
    });
    if (!response.ok) throw new Error('localization-request');
    return (await response.json()).state;
  }

  async function refresh() {
    if (pending) return;
    try {
      state = await request('status');
      feedback = state;
    } catch {
      feedback = 'failed';
    }
    render();
  }

  async function installTranslation() {
    pending = true;
    feedback = 'busy';
    render();
    try {
      feedback = await request('install');
      state = await request('status');
    } catch {
      feedback = 'failed';
    } finally {
      pending = false;
      render();
    }
  }

  open.addEventListener('click', () => {
    dialog.showModal();
    void refresh();
  });
  document.getElementById('gameLocalizationClose').addEventListener('click', () => dialog.close());
  install.addEventListener('click', () => void installTranslation());
  window.addEventListener('calculator-language', render);
  window.addEventListener('focus', refresh);
  void refresh();
})();
