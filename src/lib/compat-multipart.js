import Busboy from '@fastify/busboy';

export const MULTIPART_LIMITS = Object.freeze({ total: 60 * 1024 * 1024, file: 25 * 1024 * 1024, files: 10, fields: 40, field: 64 * 1024 });

export function readCompatMultipart(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MULTIPART_LIMITS.total) {
      req.resume();
      reject(Object.assign(new Error('Multipart total limit exceeded'), { statusCode: 413 }));
      return;
    }
    const fields = Object.create(null);
    const uploads = [];
    let total = 0;
    let failure;
    let parser;
    const fail = (message, statusCode = 400) => {
      failure ||= Object.assign(new Error(message), { statusCode });
    };
    try {
      parser = new Busboy({ headers: req.headers, limits: { fileSize: MULTIPART_LIMITS.file, files: MULTIPART_LIMITS.files, fields: MULTIPART_LIMITS.fields, fieldSize: MULTIPART_LIMITS.field, parts: MULTIPART_LIMITS.files + MULTIPART_LIMITS.fields } });
    } catch {
      reject(Object.assign(new Error('Malformed multipart boundary'), { statusCode: 400 }));
      req.resume();
      return;
    }
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MULTIPART_LIMITS.total) {
        fail('Multipart total limit exceeded', 413);
        req.unpipe(parser);
        parser.destroy(failure);
        req.resume();
      }
    };
    const onAbort = () => parser.destroy(Object.assign(new Error('Multipart request aborted'), { statusCode: 400 }));
    const finish = (error) => {
      req.off('data', onData);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
      if (error || failure) {
        uploads.length = 0;
        reject(failure || error);
      } else resolve({ body: fields, uploads });
    };
    parser.on('field', (name, value, nameTruncated, valueTruncated) => {
      if (nameTruncated || valueTruncated) fail('Multipart field limit exceeded', 413);
      if (Object.hasOwn(fields, name)) fail('Duplicate multipart field');
      fields[name] = value;
    });
    parser.on('file', (field, stream, filename, encoding, mime) => {
      const chunks = [];
      if (field !== 'files' || !filename) fail('Binary field must be files with a filename');
      const name = String(filename || 'upload.bin').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
      stream.on('limit', () => fail('Multipart file limit exceeded', 413));
      stream.on('error', (error) => fail(error.message));
      stream.on('data', (chunk) => { if (!failure) chunks.push(chunk); });
      stream.on('end', () => {
        if (failure) return;
        const buffer = Buffer.concat(chunks);
        if (!buffer.length || !name || /^\.+$/.test(name)) return fail('Empty file or invalid filename');
        uploads.push({ name, binary: true, contentType: /^[\w.+-]+\/[\w.+-]+$/.test(mime || '') ? mime : 'application/octet-stream', data: buffer.toString('base64') });
      });
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => fail('Multipart part limit exceeded', 413));
    parser.once('error', finish);
    parser.once('finish', () => finish());
    req.on('data', onData);
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    req.pipe(parser);
  });
}
