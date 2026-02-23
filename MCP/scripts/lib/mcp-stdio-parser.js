'use strict';

const EventEmitter = require('node:events');

class McpStdioParser extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxMessageBytes = Number.isFinite(options.maxMessageBytes) && options.maxMessageBytes > 0
      ? options.maxMessageBytes
      : 1024 * 1024;
    this.buffer = Buffer.alloc(0);
    this.mode = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);

    while (this.buffer.length > 0) {
      this.trimLeadingEmptyLines();
      if (this.buffer.length === 0) return;

      if (this.looksLikeFramedHeader()) {
        if (!this.processFramedMessage()) return;
      } else {
        if (!this.processLineMessage()) return;
      }
    }
  }

  trimLeadingEmptyLines() {
    while (this.buffer.length > 0) {
      const first = this.buffer[0];
      if (first === 0x0a || first === 0x0d) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      break;
    }
  }

  looksLikeFramedHeader() {
    const preview = this.buffer.slice(0, Math.min(this.buffer.length, 64)).toString('utf8');
    return /^content-length\s*:/i.test(preview);
  }

  processFramedMessage() {
    const markerCRLF = this.buffer.indexOf('\r\n\r\n');
    const markerLF = this.buffer.indexOf('\n\n');
    let markerIndex = -1;
    let markerLength = 0;

    if (markerCRLF >= 0 && (markerLF < 0 || markerCRLF < markerLF)) {
      markerIndex = markerCRLF;
      markerLength = 4;
    } else if (markerLF >= 0) {
      markerIndex = markerLF;
      markerLength = 2;
    }

    if (markerIndex < 0) return false;

    const header = this.buffer.slice(0, markerIndex).toString('utf8');
    const match = header.match(/content-length\s*:\s*(\d+)/i);
    if (!match) {
      this.emit('error', { code: 'invalid_header', message: 'missing Content-Length header' });
      this.buffer = this.buffer.slice(markerIndex + markerLength);
      return true;
    }

    const byteLength = Number.parseInt(match[1], 10);
    if (!Number.isFinite(byteLength) || byteLength < 0) {
      this.emit('error', { code: 'invalid_header', message: 'invalid Content-Length value' });
      this.buffer = this.buffer.slice(markerIndex + markerLength);
      return true;
    }

    if (byteLength > this.maxMessageBytes) {
      this.emit('error', { code: 'message_too_large', message: `message exceeds max size ${this.maxMessageBytes}` });
      this.buffer = this.buffer.slice(markerIndex + markerLength);
      return true;
    }

    const totalLength = markerIndex + markerLength + byteLength;
    if (this.buffer.length < totalLength) return false;

    const payload = this.buffer.slice(markerIndex + markerLength, totalLength).toString('utf8');
    this.buffer = this.buffer.slice(totalLength);
    this.mode = this.mode || 'framed';
    this.emitParsed(payload, 'framed');
    return true;
  }

  processLineMessage() {
    const newlineIndex = this.buffer.indexOf(0x0a);
    if (newlineIndex < 0) return false;

    const line = this.buffer.slice(0, newlineIndex).toString('utf8').trim();
    this.buffer = this.buffer.slice(newlineIndex + 1);
    if (!line) return true;

    if (Buffer.byteLength(line, 'utf8') > this.maxMessageBytes) {
      this.emit('error', { code: 'message_too_large', message: `line exceeds max size ${this.maxMessageBytes}` });
      return true;
    }

    this.mode = this.mode || 'line';
    this.emitParsed(line, 'line');
    return true;
  }

  emitParsed(raw, mode) {
    try {
      const message = JSON.parse(raw);
      this.emit('message', { message, mode });
    } catch (error) {
      this.emit('error', { code: 'parse_error', message: error.message, raw });
    }
  }
}

function writeMcpMessage(output, payload, mode) {
  const text = JSON.stringify(payload);
  if (mode === 'framed') {
    const body = Buffer.from(text, 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
    return;
  }
  output.write(`${text}\n`);
}

module.exports = {
  McpStdioParser,
  writeMcpMessage
};
