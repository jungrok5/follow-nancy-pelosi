// 의존성 없이 ZIP(저장/deflate)만 읽는 최소 구현.
// 사무처의 연도별 FD.ZIP 안에는 XML 인덱스 한 개만 들어있다.
import zlib from 'node:zlib';

export function unzip(buffer) {
  const eocdIdx = findSignature(buffer, 0x06054b50);
  if (eocdIdx < 0) throw new Error('ZIP 형식이 아닙니다 (EOCD 없음)');
  const entryCount = buffer.readUInt16LE(eocdIdx + 10);
  let offset = buffer.readUInt32LE(eocdIdx + 16);

  const files = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function findSignature(buf, sig) {
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === sig) return i;
  return -1;
}
