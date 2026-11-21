async function initAccessPoll() {
  const dialog = byId('accessPoll');
  const open = byId('openAccessPoll');
  const form = byId('accessPollForm');
  const send = byId('submitAccessPoll');
  const skip = byId('skipAccessPoll');
  const status = byId('accessPollStatus');
  let submitting = false;
  let voted = false;

  function show() {
    if (!voted && !dialog.open) dialog.showModal();
  }

  function close() {
    if (!submitting) dialog.close();
  }

  open.addEventListener('click', show);
  skip.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    if (submitting) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    try { sessionStorage.setItem('calculator-access-poll-shown', '1'); } catch { /* The sidebar can still reopen it. */ }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || voted) return;
    const choice = new FormData(form).get('accessMode');
    if (!choice) return;
    submitting = send.disabled = skip.disabled = true;
    status.textContent = t('正在提交投票…');
    try {
      const response = await fetch('access-poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice })
      });
      if (!response.ok) throw Error('poll-unavailable');
      voted = true;
      open.hidden = true;
      dialog.close();
    } catch {
      status.textContent = t('暂时无法提交投票，可以重试或稍后再投。');
    } finally {
      submitting = send.disabled = skip.disabled = false;
    }
  });
  try {
    voted = (await get('access-poll')).voted;
    open.hidden = voted;
    if (!voted && !sessionStorage.getItem('calculator-access-poll-shown')) show();
  } catch {
    open.hidden = false;
  }
}
