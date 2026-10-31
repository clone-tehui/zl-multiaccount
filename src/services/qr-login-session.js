import { LoginQRCallbackEventType } from 'zca-js';

export class QrLoginSession {
  constructor(createClient, timeoutMs = 110000) {
    this.createClient = createClient;
    this.timeoutMs = timeoutMs;
    this.current = null;
  }

  read(ownerId) {
    const flow = this.current;
    if (!flow || flow.ownerId !== String(ownerId)) return { status: 'idle' };
    return structuredClone(flow.view);
  }

  cancel(ownerId) {
    if (this.current?.ownerId === String(ownerId)) this.current.cancel('qr_cancelled');
    return this.read(ownerId);
  }

  start({ ownerId, departmentId, complete }) {
    const previous = this.current;
    if (previous?.running && previous.ownerId !== String(ownerId)) {
      const error = new Error('Một người quản trị khác đang thêm account. Hãy đợi phiên QR kết thúc.');
      error.statusCode = 409;
      throw error;
    }
    if (previous?.running) previous.cancel('qr_cancelled');
    const flow = {
      ownerId: String(ownerId), running: true, credentials: null, abort: null,
      view: { status: 'starting_qr', departmentId, qrImage: null, error: null }
    };
    this.current = flow;
    const update = (values) => {
      if (this.current === flow) Object.assign(flow.view, values);
    };
    flow.cancel = (status) => {
      if (!flow.running) return;
      flow.running = false;
      clearTimeout(flow.timer);
      update({ status, qrImage: null, error: status === 'qr_expired' ? 'Mã QR đã hết hạn. Hãy tạo mã mới.' : null });
      flow.abort?.();
    };
    flow.timer = setTimeout(() => flow.cancel('qr_expired'), this.timeoutMs);
    flow.timer.unref?.();
    flow.task = Promise.resolve().then(() => this.createClient().loginQR({}, (event) => {
      if (this.current !== flow || !flow.running) {
        event.actions?.abort?.();
        return;
      }
      if (event.actions?.abort) flow.abort = event.actions.abort;
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        const image = String(event.data?.image || '').replace(/^data:image\/png;base64,/, '');
        update({ status: 'awaiting_qr_scan', qrImage: `data:image/png;base64,${image}`, error: null });
      } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
        update({ status: 'qr_scanned' });
      } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        flow.credentials = event.data;
        clearTimeout(flow.timer);
        update({ status: 'syncing', qrImage: null });
      } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
        flow.cancel('qr_expired');
      } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
        flow.cancel('qr_declined');
        update({ error: 'Zalo đã từ chối lần quét này. Hãy tạo mã mới.' });
      }
    })).then(async (api) => {
      if (this.current !== flow || !flow.running) return;
      if (!api) {
        update({ status: 'login_error', qrImage: null, error: 'Zalo chưa xác nhận đăng nhập. Hãy tạo QR mới.' });
        return;
      }
      clearTimeout(flow.timer);
      update({ status: 'syncing', qrImage: null });
      await complete(api, flow.credentials);
      update({ status: 'connected', error: null });
    }).catch(() => {
      if (flow.running) update({ status: 'login_error', qrImage: null, error: 'Không đăng nhập được Zalo. Hãy tạo QR mới và xác nhận trên điện thoại.' });
    }).finally(() => {
      clearTimeout(flow.timer);
      flow.running = false;
      flow.credentials = null;
      flow.abort = null;
    });
    return this.read(ownerId);
  }
}
