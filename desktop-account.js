(() => {
  const open = document.getElementById('desktopAccount');
  const dialog = document.getElementById('desktopAccountDialog');
  const form = document.getElementById('desktopCredentials');
  const signedIn = document.getElementById('desktopSignedIn');
  const nameLabel = document.getElementById('desktopAccountName');
  const claimForm = document.getElementById('desktopClaimUsername');
  const signOut = document.getElementById('desktopSignOut');
  const notice = document.getElementById('desktopAccountStatus');
  const remote = document.getElementById('desktopRemoteQueue');
  const toggle = document.getElementById('desktopRemoteToggle');
  const remoteStatus = document.getElementById('desktopRemoteState');
  const remoteName = document.getElementById('desktopRemoteName');
  const computerList = document.getElementById('desktopComputerList');
  const savedComputers = document.getElementById('desktopSavedComputers');
  const syncSection = document.getElementById('desktopCharacterSync');
  const syncToggle = document.getElementById('desktopSyncToggle');
  const syncNotice = document.getElementById('desktopSyncState');
  let user;
  let pending = false;
  let status;
  let failed = false;
  let remoteState = 'disabled';
  let remoteBusy = false;
  let computers = [];
  let syncState = { active: false, state: 'disabled' };
  let syncBusy = false;

  const remoteActive = () => ['connecting', 'online', 'offline'].includes(remoteState);

  async function remoteRequest(action, body) {
    const response = await fetch('remote-queue/' + action, {
      method: ['status', 'devices'].includes(action) ? 'GET' : 'POST',
      headers: { 'X-Calculator-Account': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error('remote-unavailable');
    return response.json();
  }

  async function loadComputers(restore = false) {
    const activeUser = user;
    const result = await remoteRequest(restore ? 'restore' : 'devices');
    if (activeUser !== user) return;
    computers = result.devices;
    remoteState = result.state;
    const local = computers.find(device => device.local);
    if (local && (restore || remoteActive())) remoteName.value = local.name;
  }

  async function syncRequest(action) {
    const response = await fetch('character-sync/' + action, {
      method: action === 'status' ? 'GET' : 'POST', headers: { 'X-Calculator-Account': '1' }
    });
    if (!response.ok) throw new Error('sync-unavailable');
    return response.json();
  }

  async function request(action, body) {
    const headers = { 'X-Calculator-Account': '1' };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch('./account/' + action, {
      method: body ? 'POST' : 'GET', headers, credentials: 'omit',
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
      const byCode = {
        INVALID_EMAIL_OR_PASSWORD: '用户名或密码有误。',
        INVALID_USERNAME_OR_PASSWORD: '用户名或密码有误。',
        INVALID_USERNAME: '用户名需为 3–32 个字，可用中文、字母、数字、点、下划线和短横线。',
        USERNAME_IS_ALREADY_TAKEN: '此用户名已被使用。',
        USERNAME_IS_IMMUTABLE: '此账号已有用户名，请重新登录。',
        PASSWORD_TOO_SHORT: '注册时密码至少 8 个字符。'
      };
      const byStatus = { 400: '请检查填写的信息或要保存的内容。', 401: '请重新登录。', 429: '尝试太频繁，请稍后再试。' };
      throw new Error(byCode[data?.code] ?? byStatus[response.status] ?? '账号服务暂不可用。');
    }
    return data;
  }

  function render() {
    form.hidden = !!user;
    signedIn.hidden = !user;
    nameLabel.textContent = user?.username ?? user?.name ?? '';
    claimForm.hidden = !user || !!user.username;
    remote.hidden = !user;
    syncSection.hidden = !user;
    syncToggle.textContent = t(syncState.active ? '停止角色同步' : '开启角色同步');
    syncToggle.disabled = pending || syncBusy;
    const syncMessages = {
      syncing: '正在同步角色数据…', synced: '角色已同步，手机登录同一账号即可查看。',
      disabled: '同步已关闭。网页仍可查看上次同步的数据。',
      'no-character': '请先选择要同步的角色存档。',
      'sign-in': '请重新登录。', 'too-large': '角色数据过大，无法同步。',
      failed: '暂时无法同步角色数据，将自动重试。'
    };
    syncNotice.textContent = t(syncMessages[syncState.state] ?? '账号服务暂不可用。');
    toggle.textContent = t(remoteActive() ? '关闭远程控制' : '开启远程控制');
    toggle.disabled = pending || remoteBusy;
    remoteName.disabled = remoteActive() || remoteBusy;
    const remoteMessages = { connecting: '正在连接远程服务…', online: '本机已上线，可在网页控制。',
      offline: '远程服务暂时断开，正在重连。', unbound: '此设备已解除绑定。',
      unavailable: '此工具暂时无法开启远程控制。', 'sign-in': '请重新登录。',
      'device-limit': '连接的设备太多，请先在网页解除绑定。' };
    remoteStatus.textContent = remoteMessages[remoteState] ? t(remoteMessages[remoteState]) : '';
    savedComputers.hidden = !user || !computers.length;
    computerList.replaceChildren(...computers.map(device => {
      const row = document.createElement('li');
      row.textContent = [device.name, device.local ? t('本机') : '', t(device.online ? '在线' : '离线')].filter(Boolean).join(' · ');
      return row;
    }));
    for (const control of [...form.elements, ...claimForm.elements, signOut]) control.disabled = pending;
    notice.textContent = status ? t(status) : '';
    notice.classList.toggle('error', failed);
  }

  async function run(action) {
    if (pending) return;
    pending = true;
    failed = false;
    status = '正在处理…';
    render();
    try {
      status = await action();
    } catch (error) {
      failed = true;
      status = Object.hasOwn(english, error.message) ? error.message : '账号服务暂不可用。';
    } finally {
      pending = false;
      render();
    }
  }

  open.addEventListener('click', () => {
    dialog.showModal();
    void run(async () => {
      user = (await request('session')).user;
      if (user && !accountPreferencesEnabled) resetAccountPreferences(true);
      if (user) await Promise.all([loadComputers(), syncRequest('status').then(value => { syncState = value; })]);
    });
  });
  syncToggle.addEventListener('click', async () => {
    if (!user || syncBusy) return;
    syncBusy = true;
    render();
    try {
      if (!syncState.active) await savePreferences();
      syncState = await syncRequest(syncState.active ? 'disable' : 'enable');
    } catch {
      syncState.state = 'failed';
    } finally {
      syncBusy = false;
      render();
    }
  });
  toggle.addEventListener('click', async () => {
    if (!user || remoteBusy) return;
    remoteBusy = true;
    render();
    try {
      if (!remoteActive()) await savePreferences();
      const result = remoteActive() ? await remoteRequest('disable') :
        await remoteRequest('enable', { name: remoteName.value });
      remoteState = result.state;
      await loadComputers().catch(() => {});
      if (!['connecting', 'online', 'disabled'].includes(result.state)) remoteState = result.state;
    } catch {
      remoteState = 'unavailable';
    } finally {
      remoteBusy = false;
      render();
    }
  });
  setInterval(async () => {
    if (dialog.open && user && !pending && !syncBusy && syncState.active) {
      try {
        const state = await syncRequest('status');
        if (!syncBusy && syncState.active) { syncState = state; render(); }
      } catch { /* Keep the last status until the local tool responds. */ }
    }
    if (!dialog.open || !user || pending || remoteBusy) return;
    try {
      await loadComputers();
      if (!remoteBusy && !pending) render();
    } catch { /* Keep the last status until the local tool responds. */ }
  }, 2500);
  document.getElementById('desktopAccountClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { form.reset(); claimForm.reset(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const submit = event.submitter?.value === 'register' ? 'register' : 'login';
    const fields = new FormData(form);
    const username = fields.get('username').trim();
    const password = fields.get('password');
    void run(async () => {
      if (submit === 'register' && password.length < 8) throw new Error('注册时密码至少 8 个字符。');
      try {
        user = (await request(submit, { username, password })).user;
        resetAccountPreferences(true);
        if (user) await loadComputers(true).catch(() => {});
        form.reset();
        return submit === 'register' ? '注册成功，已登录。' : '已登录。';
      } finally {
        form.elements.password.value = '';
      }
    });
  });
  claimForm.addEventListener('submit', event => {
    event.preventDefault();
    const username = new FormData(claimForm).get('username').trim();
    void run(async () => {
      user = (await request('claim', { username })).user;
      claimForm.reset();
      return '用户名已设置。';
    });
  });
  signOut.addEventListener('click', () => void run(async () => {
    await request('logout', {});
    resetAccountPreferences(false);
    user = null;
    remoteState = 'disabled';
    computers = [];
    remoteName.value = '';
    syncState = { active: false, state: 'disabled' };
    return '已退出登录。';
  }));
  window.addEventListener('calculator-language', () => { if (dialog.open) render(); });
  open.hidden = false;
})();
