const normalizedSuggestion = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]+/gu, '');

function suggestionMatches(options, query, limit = 40) {
  const search = query.trim().toLocaleLowerCase();
  const normalized = normalizedSuggestion(search);
  if (!search) return [...options].slice(0, limit);
  const matches = [];
  for (const option of options) {
    const aliases = option.dataset.searchAliases;
    if (!aliases || !normalized) {
      if (option.value.toLocaleLowerCase().includes(search)) matches.push({ option, score: 2 });
      continue;
    }
    const values = aliases.split('\n').map(normalizedSuggestion);
    let score = 2;
    if (values.includes(normalized)) score = 0;
    else if (values.some(value => value.startsWith(normalized))) score = 1;
    else if (!values.some(value => value.includes(normalized))) continue;
    matches.push({ option, score });
  }
  return matches.sort((a, b) => a.score - b.score).slice(0, limit).map(({ option }) => option);
}

function initSuggestions(input) {
  const source = byId(input.dataset.suggestions);
  const limit = input.hasAttribute('data-all-suggestions') ? Infinity : 40;
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
  let composing = false;
  let optionCount = 0;

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

  function activate(index, center = false) {
    panel.children[activeIndex]?.setAttribute('aria-selected', 'false');
    activeIndex = index;
    const option = panel.children[index];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    const bounds = option.getBoundingClientRect();
    const top = bounds.top - panel.getBoundingClientRect().top + panel.scrollTop;
    const bottom = top + bounds.height;
    if (center) {
      panel.scrollTop = Math.max(0, top - (panel.clientHeight - bounds.height) / 2);
    } else if (top < panel.scrollTop) {
      panel.scrollTop = top;
    } else if (bottom > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = bottom - panel.clientHeight;
    }
  }

  function open(query = '') {
    const matches = suggestionMatches(source.options, query, limit);
    const empty = input.dataset.emptySuggestions;
    if (!matches.length && !empty) {
      close();
      return;
    }
    optionCount = matches.length;
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    panel.setAttribute('aria-label', input.placeholder);
    panel.replaceChildren(...matches.map((match, index) => {
      const option = create('button', match.label || match.value);
      option.type = 'button';
      option.id = panel.id + '-' + index;
      option.tabIndex = -1;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => choose(match.value));
      return option;
    }));
    if (!matches.length) {
      const message = create('div', t(empty), 'suggestion-empty muted');
      message.setAttribute('role', 'status');
      panel.append(message);
    }
    if (!expanded) {
      if (supportsPopover) panel.showPopover();
      else panel.hidden = false;
      expanded = true;
      input.setAttribute('aria-expanded', 'true');
    }
    panel.style.removeProperty('--suggestion-space');
    position();
    panel.scrollTop = 0;
    if (!query.trim() && input.dataset.selectedSuggestion !== undefined) {
      const selected = matches.findIndex(option => option.value === input.dataset.selectedSuggestion);
      if (selected >= 0) activate(selected, true);
    }
  }

  if (input.hasAttribute('data-open-on-focus')) input.addEventListener('focus', () => open());
  input.addEventListener('click', () => { if (!expanded) open(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (document.activeElement === input) open(input.value);
  });
  input.addEventListener('input', event => { if (!choosing && !composing && !event.isComposing) open(input.value); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && expanded && optionCount && (activeIndex >= 0 || input.hasAttribute('data-select-first'))) {
      event.preventDefault();
      panel.children[Math.max(0, activeIndex)].click();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!expanded) open();
      if (!expanded || !optionCount) return;
      event.preventDefault();
      const lastIndex = panel.children.length - 1;
      const next = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, lastIndex)
        : activeIndex < 0 ? lastIndex : Math.max(activeIndex - 1, 0);
      activate(next);
    }
  });
  window.addEventListener('resize', () => { if (expanded) position(); });
  window.addEventListener('scroll', event => { if (expanded && event.target !== panel) position(); }, true);
}

if (typeof module !== 'undefined') module.exports = { suggestionMatches };
