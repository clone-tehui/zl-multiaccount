const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function createZaloTools({ getJson, post, getAccountId }) {
  const root = document.getElementById('zalo-latest-tools');
  let account = '';
  let generation = 0;
  let loaded = false;
  let capabilities = [];
  let banks = [];
  let bankAccounts = [];
  let page = 0;
  let busy = false;
  const permitted = (operation) => capabilities.some((item) => item.id === operation && item.available && item.permitted);
  const run = async (operation, payload = {}) => {
    const selected = account;
    const token = generation;
    const response = await post('/api/zalo/features/run', { operation, payload });
    if (token !== generation || selected !== String(getAccountId()) || String(response.accountId) !== selected) throw new Error('Tài khoản đã thay đổi. Vui lòng thực hiện lại.');
    return response.result;
  };
  function status(message, error = false) {
    const node = root.querySelector('[role="status"]');
    if (node) { node.textContent = message; node.classList.toggle('tool-error', error); }
  }
  function confirmAction(message, action) {
    root.querySelector('dialog')?.remove();
    const token = generation;
    const dialog = document.createElement('dialog');
    dialog.className = 'tool-confirm';
    dialog.setAttribute('aria-label', 'Xác nhận thay đổi trên Zalo');
    dialog.innerHTML = `<h3>Xác nhận thay đổi</h3><p>${escape(message)}</p><p>Tài khoản đang chọn: ${escape(account)}</p><button type="button" class="primary-btn" data-confirm>Đồng ý thực hiện</button><button type="button" class="secondary-btn" data-cancel>Hủy</button>`;
    root.appendChild(dialog);
    dialog.querySelector('[data-confirm]').addEventListener('click', () => { dialog.close(); dialog.remove(); if (token === generation) action(); });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.showModal();
    dialog.querySelector('[data-cancel]').focus();
  }
  const button = (operation, text, extra = '') => `<button type="button" class="secondary-btn" data-operation="${operation}" ${permitted(operation) && !busy ? '' : 'disabled'} ${extra}>${text}</button>`;
  function paint() {
    root.innerHTML = `
      <div class="tools-intro"><h2>Công cụ Zalo</h2><p>Công cụ áp dụng riêng cho tài khoản đang chọn. Các thao tác thay đổi chỉ chạy khi bạn xác nhận.</p></div>
      <p role="status" aria-live="polite"></p>
      <div class="zalo-tools-grid">
        <section class="tool-section"><h3>Kiểm tra liên kết</h3><p>Gửi liên kết đến Zalo để kiểm tra cảnh báo an toàn.</p>
          <form data-form="scanURL"><label>Liên kết<input name="url" type="url" required placeholder="https://…" /></label>${button('scanURL', 'Kiểm tra', 'data-submit="true"')}</form>
        </section>
        <section class="tool-section"><h3>Thiết bị liên kết</h3><p>Xem các thiết bị Zalo trả về. Không bao gồm khóa hay chữ ký phiên đăng nhập.</p>${button('getListDevice', 'Xem thiết bị')}<div id="zalo-device-results"></div></section>
        <section class="tool-section"><h3>Danh mục sản phẩm</h3><p>Đăng ký hoặc ngừng đăng ký tính năng danh mục của Zalo. Đây không phải trình quản lý sản phẩm.</p>${button('registerCatalog', 'Bật danh mục', 'data-enabled="true"')}${button('registerCatalog', 'Tắt danh mục', 'data-enabled="false"')}</section>
        <section class="tool-section"><h3>Trạng thái ứng dụng</h3><p>Báo cho Zalo rằng bạn đã rời giao diện này. Việc đồng bộ tin nhắn của các account vẫn tiếp tục.</p>${button('lostFocus', 'Báo rời ứng dụng')}</section>
        <section class="tool-section tool-bank"><h3>Thông tin ngân hàng trên Zalo</h3><p>Quản lý thông tin nhận tiền đã lưu, không thực hiện chuyển tiền. Chỉ người có quyền quản lý kênh được sử dụng.</p>
          ${button('getListBankAccount', 'Tải danh sách')}${button('getListBank', 'Tải ngân hàng')}
          <div id="zalo-bank-results"></div>
          <div class="bank-pagination"><button type="button" data-page="prev" ${page > 0 && !busy ? '' : 'disabled'}>Trang trước</button><span>Trang ${page + 1}</span><button type="button" data-page="next" disabled>Trang sau</button></div>
          <form data-form="bank"><h4 id="bank-form-title">Thêm thông tin nhận tiền</h4><input type="hidden" name="accountId" />
            <label>Ngân hàng<select name="binBank" required><option value="">Tải danh sách ngân hàng trước</option>${banks.map((bank) => `<option value="${escape(bank.bin)}">${escape(bank.short_name || bank.name)}</option>`).join('')}</select></label>
            <label>Số tài khoản<input name="numAccBank" required maxlength="40" autocomplete="off" /></label>
            <label>Tên chủ tài khoản<input name="nameAccBank" required maxlength="100" autocomplete="off" /></label>
            ${button('createBankAccount', 'Lưu thông tin', 'data-submit="true"')}<button type="reset" class="secondary-btn">Hủy sửa</button>
          </form>
        </section>
      </div>`;
    root.querySelectorAll('[data-submit]').forEach((node) => { node.type = 'submit'; });
    root.querySelectorAll('form').forEach((form) => form.addEventListener('submit', (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form));
      const operation = form.dataset.form === 'bank' ? (payload.accountId ? 'updateBankAccount' : 'createBankAccount') : form.dataset.form;
      if (form.dataset.form === 'bank') {
        confirmAction(`Lưu thông tin nhận tiền: ${payload.nameAccBank} · ${payload.numAccBank}?`, () => act(operation, payload));
        return;
      }
      act(operation, payload);
    }));
    root.querySelector('[data-form="bank"]').addEventListener('reset', () => {
      root.querySelector('#bank-form-title').textContent = 'Thêm thông tin nhận tiền';
      root.querySelector('[name="accountId"]').value = '';
    });
    root.querySelectorAll('[data-operation]:not([data-submit])').forEach((node) => node.addEventListener('click', () => {
      const operation = node.dataset.operation;
      if (operation === 'registerCatalog') {
        confirmAction(`${node.dataset.enabled === 'true' ? 'Bật' : 'Tắt'} đăng ký danh mục cho tài khoản đang chọn?`, () => act(operation, { enabled: node.dataset.enabled === 'true' }));
        return;
      }
      act(operation, operation === 'registerCatalog' ? { enabled: node.dataset.enabled === 'true' } : operation === 'getListBankAccount' ? { page, limit: 20 } : {});
    }));
    root.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => { page = Math.max(0, page + (node.dataset.page === 'next' ? 1 : -1)); act('getListBankAccount', { page, limit: 20 }); }));
  }
  async function act(operation, payload = {}) {
    if (busy || !permitted(operation)) return;
    const token = generation;
    busy = true;
    root.querySelectorAll('button').forEach((node) => { node.disabled = true; });
    status('Đang thực hiện…');
    try {
      const result = await run(operation, payload);
      if (operation === 'getListBank') {
        banks = Array.isArray(result.banks) ? result.banks : [];
        const select = root.querySelector('[name="binBank"]');
        select.innerHTML = `<option value="">Chọn ngân hàng</option>${banks.map((bank) => `<option value="${escape(bank.bin)}">${escape(bank.short_name || bank.name)}</option>`).join('')}`;
      } else if (operation === 'getListBankAccount') {
        bankAccounts = Array.isArray(result.myBanks) ? result.myBanks : [];
        root.querySelector('#zalo-bank-results').innerHTML = bankAccounts.length ? bankAccounts.map((bank, index) => `<div class="bank-row"><div><strong>${escape(bank.holder_name)}</strong><p>${escape(bank.bank_number)} · ${escape(bank.bin)}</p></div><button type="button" data-edit="${index}">Sửa</button><button type="button" data-delete="${index}">Xóa</button></div>`).join('') : '<p>Chưa có thông tin nhận tiền ở trang này.</p>';
        root.querySelectorAll('[data-edit]').forEach((node) => node.addEventListener('click', () => {
          const bank = bankAccounts[Number(node.dataset.edit)];
          const form = root.querySelector('[data-form="bank"]');
          form.elements.accountId.value = bank.account_id || bank.id;
          if (!banks.some((item) => String(item.bin) === String(bank.bin))) form.elements.binBank.add(new Option(String(bank.bin), String(bank.bin)));
          form.elements.binBank.value = bank.bin;
          form.elements.numAccBank.value = bank.bank_number || '';
          form.elements.nameAccBank.value = bank.holder_name || '';
          root.querySelector('#bank-form-title').textContent = 'Sửa thông tin nhận tiền';
          form.scrollIntoView({ block: 'center' });
        }));
        root.querySelectorAll('[data-delete]').forEach((node) => node.addEventListener('click', () => {
          const bank = bankAccounts[Number(node.dataset.delete)];
          confirmAction(`Xóa thông tin nhận tiền ${bank.bank_number} khỏi tài khoản Zalo đang chọn?`, () => act('deleteBankAccount', { accountId: bank.account_id || bank.id, isDefault: Boolean(bank.is_default ?? bank.default) }));
        }));
        root.querySelector('.bank-pagination span').textContent = `Trang ${page + 1}`;
        root.querySelector('[data-page="next"]').dataset.hasMore = String(Boolean(result.hasMore));
      } else if (operation === 'getListDevice') {
        root.querySelector('#zalo-device-results').innerHTML = `<p>${result.primaryDevicePresent ? 'Có thiết bị chính' : 'Không có thông tin thiết bị chính'}</p>${result.companions.map((item) => `<p>${escape(item.name)}${item.type ? ` · ${escape(item.type)}` : ''}</p>`).join('') || '<p>Zalo không trả về thiết bị đồng hành.</p>'}`;
      } else if (['createBankAccount', 'updateBankAccount', 'deleteBankAccount'].includes(operation)) {
        root.querySelector('#zalo-bank-results').textContent = 'Đã thay đổi. Tải danh sách để xem thông tin mới nhất.';
        root.querySelector('[data-form="bank"]').reset();
      }
      status(operation === 'scanURL' ? (result.isSafe ? 'Zalo chưa ghi nhận cảnh báo cho liên kết này. Vẫn kiểm tra trước khi mở.' : 'Zalo cảnh báo liên kết có thể không an toàn.') : operation === 'lostFocus' && result.status === false ? 'Zalo không chấp nhận thay đổi trạng thái.' : 'Đã thực hiện thành công.');
    } catch (error) {
      if (token === generation) status(error.message || 'Thực hiện thất bại.', true);
    } finally {
      if (token === generation) {
        busy = false;
        root.querySelectorAll('[data-operation]').forEach((node) => { node.disabled = !permitted(node.dataset.operation); });
        root.querySelectorAll('[data-edit]').forEach((node) => { node.disabled = !permitted('updateBankAccount'); });
        root.querySelectorAll('[data-delete]').forEach((node) => { node.disabled = !permitted('deleteBankAccount'); });
        root.querySelector('[type="reset"]').disabled = false;
        root.querySelector('[data-page="prev"]').disabled = page === 0 || !permitted('getListBankAccount');
        root.querySelector('[data-page="next"]').disabled = root.querySelector('[data-page="next"]').dataset.hasMore !== 'true' || !permitted('getListBankAccount');
      }
    }
  }
  async function activate() {
    update();
    if (loaded || !account) return;
    loaded = true;
    const token = generation;
    status('Đang kiểm tra kết nối và quyền sử dụng…');
    try {
      const response = await getJson('/api/zalo/features');
      if (token !== generation) return;
      capabilities = response.features || [];
      paint();
      if (!response.connected) status('Account chưa kết nối. Kết nối lại trong Cài đặt để sử dụng công cụ.', true);
    } catch (error) { if (token === generation) { loaded = false; status(error.message, true); } }
  }
  function update() {
    const selected = String(getAccountId() || '');
    if (selected === account) return;
    account = selected; generation++; loaded = false; busy = false; banks = []; bankAccounts = []; capabilities = []; page = 0;
    paint();
    if (document.body.dataset.workspaceView === 'tools') queueMicrotask(activate);
  }
  document.addEventListener('workspace-view', (event) => { if (event.detail === 'tools') { loaded = false; activate(); } });
  paint();
  return { update };
}
