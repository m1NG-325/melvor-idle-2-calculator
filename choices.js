function initSuggestions(input) {
  const source = byId(input.dataset.suggestions);
  const panel = create('div', undefined, 'suggestion-picker');
  const supportsPopover = typeof panel.showPopover === 'function';
  panel.id = input.id + 'Suggestions';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', input.placeholder);
  if (supportsPopover) panel.popover = 'manual';
  else panel.hidden = true;
  document.body.append(panel);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', panel.id);
  input.setAttribute('aria-expanded', 'false');
  let expanded = false;
  let activeIndex = -1;
  let choosing = false;

  function close() {
    if (!expanded) return;
    if (supportsPopover) panel.hidePopover();
    else panel.hidden = true;
    expanded = false;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function position() {
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 190), document.documentElement.clientWidth - 16);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)) + 'px';
    const below = document.documentElement.clientHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const openAbove = below < panel.offsetHeight + 5 && above > below;
    panel.style.setProperty('--suggestion-space', Math.max(36, (openAbove ? above : below) - 5) + 'px');
    panel.style.top = (openAbove ? rect.top - panel.offsetHeight - 5 : rect.bottom + 5) + 'px';
  }

  function choose(value) {
    input.value = value;
    close();
    choosing = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    choosing = false;
  }

  function open(query = '') {
    const search = query.trim().toLocaleLowerCase();
    const values = Array.from(source.options, option => option.value)
      .filter(value => value.toLocaleLowerCase().includes(search)).slice(0, 40);
    if (!values.length) {
      close();
      return;
    }
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    panel.setAttribute('aria-label', input.placeholder);
    panel.replaceChildren(...values.map((value, index) => {
      const option = create('button', value);
      option.type = 'button';
      option.id = panel.id + '-' + index;
      option.tabIndex = -1;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => choose(value));
      return option;
    }));
    if (!expanded) {
      if (supportsPopover) panel.showPopover();
      else panel.hidden = false;
      expanded = true;
      input.setAttribute('aria-expanded', 'true');
    }
    panel.style.removeProperty('--suggestion-space');
    position();
    panel.scrollTop = 0;
  }

  input.addEventListener('click', () => { if (!expanded) open(); });
  input.addEventListener('input', () => { if (!choosing) open(input.value); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && expanded && activeIndex >= 0) {
      event.preventDefault();
      panel.children[activeIndex].click();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!expanded) open();
      if (!expanded) return;
      event.preventDefault();
      panel.children[activeIndex]?.setAttribute('aria-selected', 'false');
      const lastIndex = panel.children.length - 1;
      activeIndex = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, lastIndex)
        : activeIndex < 0 ? lastIndex : Math.max(activeIndex - 1, 0);
      const option = panel.children[activeIndex];
      option.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
  window.addEventListener('resize', () => { if (expanded) position(); });
  window.addEventListener('scroll', event => { if (expanded && event.target !== panel) position(); }, true);
}
