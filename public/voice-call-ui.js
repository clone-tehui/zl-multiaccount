import { CallJitterBuffer } from './voice-call-audio.js?v=20261031-calls';

export function createVoiceCallUi({ getSelection, getAccountId = () => getSelection()?.accountId, getJson, notice }) {
  const panel = document.getElementById('voice-call-panel');
  const callButton = document.getElementById('btn-voice-call');
  const title = document.getElementById('voice-call-title');
  const status = document.getElementById('voice-call-status');
  const acceptButton = document.getElementById('btn-call-accept');
  const muteButton = document.getElementById('btn-call-mute');
  const endButton = document.getElementById('btn-call-end');
  const dismissButton = document.getElementById('btn-call-dismiss');
  let current = null;
  let pending = null;
  let generation = 0;
  let ringContext = null;
  let ringTimer = null;
  const stopRing = () => {
    clearInterval(ringTimer);
    ringTimer = null;
    void ringContext?.close().catch(() => {});
    ringContext = null;
  };
  const ring = () => {
    stopRing();
    try {
      ringContext = new AudioContext();
      const play = () => {
        if (!ringContext || ringContext.state !== 'running') return;
        const tone = ringContext.createOscillator();
        const gain = ringContext.createGain();
        tone.frequency.value = 660;
        gain.gain.value = 0.06;
        tone.connect(gain).connect(ringContext.destination);
        tone.start(); tone.stop(ringContext.currentTime + 0.25);
        tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      };
      void ringContext.resume().then(play).catch(() => {});
      ringTimer = setInterval(play, 1600);
    } catch { /* Visual banner remains available when autoplay is blocked. */ }
  };
  const show = (selection, message) => {
    title.textContent = selection.name || 'Cuộc gọi Zalo';
    status.textContent = message;
    panel.hidden = false;
  };
  const fail = (message) => {
    notice(message, 'danger');
    status.textContent = message;
    stop(false);
  };
  const stop = (hide = true) => {
    generation += 1;
    pending = null;
    stopRing();
    const closing = current;
    current = null;
    if (closing) {
      clearInterval(closing.decodeTimer);
      clearInterval(closing.durationTimer);
      clearTimeout(closing.setupTimer);
      closing.playing?.forEach((source) => { try { source.stop(); source.disconnect(); } catch {} });
      closing.stream?.getTracks().forEach((track) => track.stop());
      closing.capture?.disconnect();
      closing.source?.disconnect();
      if (closing.encoder?.state !== 'closed') closing.encoder?.close();
      if (closing.decoder?.state !== 'closed') closing.decoder?.close();
      void closing.context?.close().catch(() => {});
      if (closing.socket?.readyState === WebSocket.OPEN) closing.socket.send(JSON.stringify({ type: 'end' }));
      closing.socket?.close();
    }
    muteButton.hidden = true;
    acceptButton.hidden = true;
    endButton.hidden = true;
    dismissButton.hidden = hide;
    panel.hidden = hide;
    callButton.disabled = !getSelection();
  };
  const connect = (selection, action, call) => {
    const url = new URL('/api/calls/media', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('accountId', selection.accountId);
    url.searchParams.set('threadId', selection.threadId);
    url.searchParams.set('mediaVersion', '2');
    const socket = new WebSocket(url);
    call.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      if (current !== call) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length >= 9 && bytes[0] === 0x5a && bytes[1] === 0x43) {
          call.jitter.push(new DataView(event.data).getUint16(2), bytes.slice(8));
        } else call.jitter.push(call.legacySequence++ & 0xffff, bytes);

        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === 'ready') socket.send(JSON.stringify({ type: action }));
      else if (message.type === 'state') {
        const labels = { allocating: 'Đang kết nối…', handshaking_udp: 'Đang kết nối âm thanh…', ringing: 'Đã gửi lời mời, đang chờ người nhận…', active: 'Đang gọi', ended: 'Cuộc gọi đã kết thúc', error: 'Kết nối cuộc gọi bị lỗi' };
        status.textContent = labels[message.status] || 'Đang kết nối…';
        if (message.status === 'active' && !call.activeAt) {
          call.activeAt = Date.now();
          clearTimeout(call.setupTimer);
          call.durationTimer = setInterval(() => {
            const seconds = Math.floor((Date.now() - call.activeAt) / 1000);
            status.textContent = `Đang gọi · ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
          }, 1000);
        }
        if (['ended', 'error'].includes(message.status)) stop(false);
      } else if (message.type === 'error') fail(message.message);
    };
    socket.onerror = () => { if (current === call) fail('Không kết nối được cuộc gọi. Hãy kiểm tra mạng và account Zalo.'); };
    socket.onclose = () => {
      if (current === call) { status.textContent = 'Cuộc gọi đã kết thúc'; stop(false); }
    };
  };
  const start = async (selection, action = 'start') => {
    if (!selection || current) return;
    pending = null;
    stopRing();
    const callGeneration = ++generation;
    const call = { ...selection, receivedTimestamp: 0, sentTimestamp: 0, playbackAt: 0, jitter: new CallJitterBuffer(), legacySequence: 0, playing: new Set() };
    current = call;
    callButton.disabled = true;
    acceptButton.hidden = true;
    endButton.hidden = false;
    endButton.textContent = 'Ngắt máy';
    dismissButton.hidden = true;
    show(selection, 'Đang chuẩn bị micro…');
    call.setupTimer = setTimeout(() => { if (current === call && !call.activeAt) fail('Hết thời gian chờ kết nối. Hãy kiểm tra quyền micro, mạng và quyền nhận cuộc gọi trên Zalo.'); }, 65000);
    try {
      const capabilities = await getJson(`/api/calls/capabilities?accountId=${encodeURIComponent(selection.accountId)}&threadId=${encodeURIComponent(selection.threadId)}`);
      if (!capabilities.audio) throw new Error('Account chưa kết nối Zalo hoặc chưa hỗ trợ gọi thoại.');
      if (!window.AudioEncoder || !window.AudioDecoder || !navigator.mediaDevices?.getUserMedia) throw new Error('Trình duyệt chưa hỗ trợ gọi thoại. Hãy mở bằng Chrome hoặc Edge bản mới qua HTTPS.');
      const config = { codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 24000 };
      if (!(await AudioEncoder.isConfigSupported(config)).supported || !(await AudioDecoder.isConfigSupported(config)).supported) throw new Error('Trình duyệt không hỗ trợ bộ mã âm thanh Opus cần cho cuộc gọi này.');
      if (current !== call) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== call || generation !== callGeneration) { stream.getTracks().forEach((track) => track.stop()); return; }
      call.stream = stream;
      if (stream.getAudioTracks()[0]?.getSettings?.().echoCancellation === false) notice('Thiết bị chưa bật khử vọng âm; hãy dùng tai nghe để giảm echo.', 'warning');
      try { call.context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }); }
      catch { call.context = new AudioContext({ latencyHint: 'interactive' }); }
      await call.context.resume();
      await call.context.audioWorklet.addModule('/call-audio-worklet.js?v=20261031-calls');
      if (current !== call) return;
      call.encoder = new AudioEncoder({
        output: (chunk) => {
          if (current !== call || call.socket?.readyState !== WebSocket.OPEN || call.socket.bufferedAmount > 4096) return;
          const frame = new Uint8Array(chunk.byteLength);
          chunk.copyTo(frame);
          call.socket.send(frame);
        },
        error: () => { if (current === call) fail('Micro gặp lỗi mã hóa âm thanh. Hãy thử gọi lại.'); }
      });
      call.encoder.configure(config);
      call.decoder = new AudioDecoder({
        output: (audio) => {
          try {
            if (current !== call) return;
            const now = call.context.currentTime;
            // A late TCP burst must not overlap scheduled audio or add unbounded delay.
            if (call.playbackAt > now + 0.12) return;
            const samples = new Float32Array(audio.numberOfFrames);
            audio.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
            const buffer = call.context.createBuffer(1, samples.length, audio.sampleRate);
            buffer.copyToChannel(samples, 0);
            const source = call.context.createBufferSource();
            source.buffer = buffer;
            source.connect(call.context.destination);
            call.playbackAt = Math.max(now + 0.03, call.playbackAt);
            call.playing.add(source);
            source.onended = () => { call.playing.delete(source); source.disconnect(); };
            source.start(call.playbackAt);
            call.playbackAt += buffer.duration;
          } finally { audio.close(); }
        },
        error: () => { if (current === call) fail('Âm thanh cuộc gọi gặp lỗi. Hãy thử gọi lại.'); }
      });
      call.decoder.configure(config);
      call.decodeTimer = setInterval(() => {
        if (current !== call || call.decoder.state !== 'configured' || call.decoder.decodeQueueSize > 3) return;
        const frame = call.jitter.take();
        if (!frame) return;
        try {
          call.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: call.receivedTimestamp, duration: 20000, data: frame }));
          call.receivedTimestamp += 20000;
        } catch { fail('Không giải mã được âm thanh. Hãy ngắt máy và thử lại.'); }
      }, 20);
      call.capture = new AudioWorkletNode(call.context, 'zalo-call-audio');
      call.capture.port.onmessage = ({ data }) => {
        if (current !== call || call.encoder.state !== 'configured' || call.encoder.encodeQueueSize > 5) return;
        if (call.muted) data.fill(0);
        const audio = new AudioData({ format: 'f32', sampleRate: 16000, numberOfFrames: data.length, numberOfChannels: 1, timestamp: call.sentTimestamp, data });
        call.sentTimestamp += 20000;
        call.encoder.encode(audio);
        audio.close();
      };
      call.source = call.context.createMediaStreamSource(stream);
      call.source.connect(call.capture);
      const silence = call.context.createGain();
      silence.gain.value = 0;
      call.capture.connect(silence).connect(call.context.destination);
      muteButton.hidden = false;
      muteButton.textContent = 'Tắt micro';
      muteButton.setAttribute('aria-pressed', 'false');
      show(selection, 'Đang kết nối cuộc gọi…');
      connect(selection, action, call);
    } catch (error) {
      if (current === call) fail(error.name === 'NotAllowedError' ? 'Chưa được cấp quyền micro. Hãy cho phép micro rồi gọi lại.' : error.message);
    }
  };
  callButton.addEventListener('click', () => start(getSelection()));
  acceptButton.addEventListener('click', () => { if (pending) void start(pending, 'accept'); });
  dismissButton.addEventListener('click', () => stop());
  endButton.addEventListener('click', () => {
    if (pending && !current) {
      const rejecting = pending;
      pending = null;
      stopRing();
      const call = { ...rejecting };
      current = call;
      connect(rejecting, 'reject', call);
      show(rejecting, 'Đang từ chối cuộc gọi…');
    } else stop();
  });
  muteButton.addEventListener('click', () => {
    if (!current?.stream) return;
    current.muted = !current.muted;
    current.stream.getAudioTracks().forEach((track) => { track.enabled = !current.muted; });
    muteButton.textContent = current.muted ? 'Bật micro' : 'Tắt micro';
    muteButton.setAttribute('aria-pressed', String(current.muted));
  });
  window.addEventListener('pagehide', () => stop());
  return {
    updateSelection() {
      const selection = getSelection();
      if (current && getAccountId() !== current.accountId) stop();
      if (pending && getAccountId() !== pending.accountId) { pending = null; stopRing(); panel.hidden = true; }
      callButton.disabled = Boolean(current || pending) || !selection;
    },
    incoming(payload) {
      if (getAccountId() !== payload.accountId || current) return;
      pending = { accountId: payload.accountId, threadId: payload.threadId, callId: payload.callId, name: 'Cuộc gọi Zalo đến' };
      callButton.disabled = true;
      show(pending, 'Có cuộc gọi đến');
      ring();
      acceptButton.hidden = false;
      endButton.hidden = false;
      endButton.textContent = 'Từ chối';
      dismissButton.hidden = true;
      muteButton.hidden = true;
    },
    ended(payload) {
      if (pending && pending.accountId === payload.accountId && pending.callId === payload.callId) stop();
    },
    stop
  };
}
