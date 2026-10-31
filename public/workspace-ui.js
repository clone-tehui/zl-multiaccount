const paths = {
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  contacts: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5h4M17 10h4M18 15h3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  attachment: '<path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8L16 5"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 3 4 3 4-3 4-3M8 8h.01M16 8h.01"/>',
  sticker: '<path d="M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9zM14 21v-5a2 2 0 0 1 2-2h5"/><path d="M7 8h.01M14 8h.01M7 11s2 3 5 2"/>',
  logout: '<path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h13"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  reply: '<path d="m9 4-7 7 7 7M2 11h10a9 9 0 0 1 9 9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  phone: '<path d="m7 3 3 5-3 3a15 15 0 0 0 6 6l3-3 5 3v3a2 2 0 0 1-2 2C10 22 2 14 2 5a2 2 0 0 1 2-2z"/>'
};

export function uiIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

export function paintWorkspaceIcons(root = document) {
  root.querySelectorAll('[data-icon]:not([data-painted])').forEach((element) => {
    if (!paths[element.dataset.icon]) return;
    element.innerHTML = uiIcon(element.dataset.icon);
    element.dataset.painted = 'true';
  });
}

export function createWorkspaceUi({ openView, getSelection, getMessageRows, onFilter, onSearchClear }) {
  const listSearch = document.getElementById('thread-search');
  const searchInput = document.getElementById('chat-message-query');
  const searchBar = document.getElementById('chat-search-bar');
  const count = document.getElementById('chat-search-count');
  const rail = document.querySelector('.workspace-rail');
  let matchedRows = [];
  let matchIndex = 0;
  let previousAccount = null;
  let previousThread = null;
  const setView = (name) => {
    document.body.dataset.workspaceView = name;
    openView(name === 'chats' ? 'chats' : 'utility');
    if (name !== 'chats') document.body.dataset.mobileChat = 'closed';
    document.dispatchEvent(new CustomEvent('workspace-view', { detail: name }));
    document.querySelectorAll('.rail-button').forEach((button) => button.classList.toggle('active', button.id === `nav-${name}`));
    const section = name === 'contacts' ? document.getElementById('friend-search-query') : name === 'tools' ? document.getElementById('zalo-latest-tools') : document.getElementById('utility-rbac-panel');
    section?.scrollIntoView({ block: 'start' });
  };
  for (const name of ['chats', 'contacts', 'tools', 'settings']) document.getElementById(`nav-${name}`).addEventListener('click', () => setView(name));
  rail.appendChild(document.getElementById('btn-theme-toggle'));
  rail.appendChild(document.getElementById('btn-logout'));
  document.getElementById('btn-mobile-back').addEventListener('click', () => {
    document.body.dataset.mobileChat = 'closed';
    listSearch.focus();
  });
  document.querySelectorAll('[data-inbox-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-inbox-filter]').forEach((item) => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    onFilter(button.dataset.inboxFilter);
  }));
  document.getElementById('btn-clear-search').addEventListener('click', () => {
    listSearch.value = '';
    onSearchClear();
    listSearch.focus();
  });
  const jumpToMatch = () => {
    matchedRows.forEach((row, index) => row.classList.toggle('message-search-current', index === matchIndex));
    matchedRows[matchIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    count.textContent = matchedRows.length ? `${matchIndex + 1} / ${matchedRows.length}` : (searchInput.value ? 'Không tìm thấy trong tin đã tải' : 'Tìm trong tin đã tải');
  };
  const find = () => {
    const query = searchInput.value.trim().toLocaleLowerCase('vi');
    const rows = getMessageRows();
    rows.forEach((row) => row.classList.remove('message-search-match', 'message-search-current'));
    matchedRows = query ? rows.filter((row) => row.querySelector('.message-bubble')?.textContent.toLocaleLowerCase('vi').includes(query)) : [];
    matchedRows.forEach((row) => row.classList.add('message-search-match'));
    matchIndex = 0;
    jumpToMatch();
  };
  const closeSearch = () => {
    searchBar.hidden = true;
    searchInput.value = '';
    getMessageRows().forEach((row) => row.classList.remove('message-search-match', 'message-search-current'));
  };
  document.getElementById('btn-chat-search').addEventListener('click', () => {
    searchBar.hidden = !searchBar.hidden;
    if (!searchBar.hidden) { searchInput.focus(); find(); }
  });
  searchInput.addEventListener('input', find);
  document.getElementById('btn-search-next').addEventListener('click', () => { matchIndex = (matchIndex + 1) % (matchedRows.length || 1); jumpToMatch(); });
  document.getElementById('btn-search-prev').addEventListener('click', () => { matchIndex = (matchIndex - 1 + matchedRows.length) % (matchedRows.length || 1); jumpToMatch(); });
  document.getElementById('btn-close-chat-search').addEventListener('click', closeSearch);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSearch();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && getSelection()?.threadId) {
      event.preventDefault(); searchBar.hidden = false; searchInput.focus(); find();
    }
  });
  paintWorkspaceIcons();
  document.getElementById('btn-thread-meta').innerHTML = uiIcon('info');
  document.getElementById('btn-thread-meta').setAttribute('aria-label', 'Thông tin hội thoại');
  document.getElementById('btn-voice-call').innerHTML = uiIcon('phone');
  document.getElementById('btn-voice-call').setAttribute('aria-label', 'Gọi thoại');
  document.getElementById('btn-voice-call').title = 'Gọi thoại';
  return {
    update() {
      const selected = getSelection() || {};
      if (selected.accountId !== previousAccount) { document.body.dataset.mobileChat = 'closed'; closeSearch(); }
      if (selected.threadId !== previousThread) closeSearch();
      previousAccount = selected.accountId;
      previousThread = selected.threadId;
      document.getElementById('btn-clear-search').hidden = !listSearch.value;
      paintWorkspaceIcons();
    },
    refreshSearch() { if (!searchBar.hidden) find(); }
  };
}
