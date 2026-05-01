const textDecoder = new TextDecoder();

export async function readStreamingText(stream, { signal, onDelta } = {}) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let responseText = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) return { text: responseText, usage };

    if (signal?.aborted) throw new Error("Request aborted.");

    buffer = appendChunk(buffer, value);
    const decoded = decodeEventStream(buffer);
    buffer = decoded.remainder;

    for (const message of decoded.messages) {
      const messageType = message.headers[":message-type"];
      if (messageType === "exception") {
        const errorText =
          message.data?.message ||
          message.data?.Message ||
          message.headers[":exception-type"] ||
          "Bedrock streaming request failed.";
        throw new Error(errorText);
      }

      const eventType = message.headers[":event-type"];
      if (eventType === "metadata" && message.data?.usage) {
        usage = message.data.usage;
        continue;
      }

      if (eventType !== "contentBlockDelta") continue;

      const text = message.data?.delta?.text;
      if (text) {
        responseText += text;
        onDelta?.(text);
      }
    }
  }
}

function appendChunk(buffer, chunk) {
  if (!buffer.length) return chunk;
  const merged = new Uint8Array(buffer.length + chunk.length);
  merged.set(buffer);
  merged.set(chunk, buffer.length);
  return merged;
}

function decodeEventStream(buffer) {
  let offset = 0;
  const messages = [];

  while (buffer.length - offset >= 12) {
    const totalLength = readUint32(buffer, offset);
    if (totalLength < 16) throw new Error("Invalid Bedrock stream message length.");
    if (buffer.length - offset < totalLength) break;

    messages.push(decodeEventMessage(buffer.subarray(offset, offset + totalLength)));
    offset += totalLength;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

function decodeEventMessage(messageBytes) {
  const headersLength = readUint32(messageBytes, 4);
  const headersStart = 12;
  const headersEnd = headersStart + headersLength;

  return {
    headers: decodeHeaders(messageBytes.subarray(headersStart, headersEnd)),
    data: decodePayload(messageBytes.subarray(headersEnd, messageBytes.length - 4)),
  };
}

function decodeHeaders(headerBytes) {
  const headers = {};
  let offset = 0;

  while (offset < headerBytes.length) {
    const nameLength = headerBytes[offset];
    offset += 1;
    const name = textDecoder.decode(headerBytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = headerBytes[offset];
    offset += 1;
    const { value, nextOffset } = decodeHeaderValue(headerBytes, offset, type);
    headers[name] = value;
    offset = nextOffset;
  }

  return headers;
}

function decodeHeaderValue(bytes, offset, type) {
  switch (type) {
    case 0: return { value: true, nextOffset: offset };
    case 1: return { value: false, nextOffset: offset };
    case 2: return { value: bytes[offset], nextOffset: offset + 1 };
    case 3: return { value: readUint16(bytes, offset), nextOffset: offset + 2 };
    case 4: return { value: readUint32(bytes, offset), nextOffset: offset + 4 };
    case 5: return { value: readBigInt64(bytes, offset), nextOffset: offset + 8 };
    case 6:
    case 7: {
      const length = readUint16(bytes, offset);
      const valueOffset = offset + 2;
      const nextOffset = valueOffset + length;
      const valueBytes = bytes.subarray(valueOffset, nextOffset);
      return { value: type === 7 ? textDecoder.decode(valueBytes) : valueBytes, nextOffset };
    }
    case 8: return { value: readBigInt64(bytes, offset), nextOffset: offset + 8 };
    case 9: return { value: bytes.subarray(offset, offset + 16), nextOffset: offset + 16 };
    default: throw new Error(`Unsupported Bedrock stream header type: ${type}`);
  }
}

function decodePayload(payloadBytes) {
  if (!payloadBytes.length) return null;
  return JSON.parse(textDecoder.decode(payloadBytes));
}

function readUint16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readBigInt64(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, false);
}
