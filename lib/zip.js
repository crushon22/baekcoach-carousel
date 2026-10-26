// 외부 라이브러리 없는 zip 생성기 — store(무압축) + CRC32 + UTF-8 파일명 플래그(한글 파일명).
// 사용: const blob = await makeZip([{name:'카드_01.png', data: Blob}, {name:'캡션.txt', data:'문자열'}]);
// 이 파일은 DOM·chrome API에 의존하지 않는다(서비스워커·Node 20+ 에서도 돈다).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zip 표준). prev 를 주면 이어서 계산한다. */
export function crc32(u8, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return enc.encode(data);
  if (data == null) return new Uint8Array(0);
  throw new Error('makeZip: data 는 Blob·Uint8Array·ArrayBuffer·문자열이어야 합니다.');
}

/** 경로 정리: 역슬래시→슬래시, 앞의 / 제거, .. 와 빈 조각 제거, 금지 문자 제거. */
export function safeZipName(name) {
  const parts = String(name || 'file').replace(/\\/g, '/').split('/')
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || 'file';
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * files: [{name, data: Blob|Uint8Array|ArrayBuffer|string, date?: Date}]
 * 반환: Blob(application/zip). 같은 이름이 겹치면 "이름 (2).확장자" 로 바꾼다.
 * 한계: zip64 미지원 — 파일 하나 4GB 이하, 파일 수 65535개 이하(이 앱에서는 충분).
 */
export async function makeZip(files, { now = new Date() } = {}) {
  if (!Array.isArray(files)) throw new Error('makeZip: files 는 배열이어야 합니다.');
  if (files.length > 65535) throw new Error('makeZip: 파일이 너무 많습니다.');
  const used = new Set();
  const parts = [];       // Blob 에 넣을 조각들
  const central = [];     // 중앙 디렉터리 조각들
  let offset = 0;
  for (const f of files) {
    let name = safeZipName(f.name);
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const slash = name.lastIndexOf('/');
      const base = dot > slash ? name.slice(0, dot) : name;
      const ext = dot > slash ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${base} (${n})${ext}`)) n++;
      name = `${base} (${n})${ext}`;
    }
    used.add(name);
    const nameBytes = enc.encode(name);
    const bytes = await toBytes(f.data);
    if (bytes.length > 0xfffffffe) throw new Error('makeZip: 파일이 4GB 를 넘습니다: ' + name);
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(f.date instanceof Date ? f.date : now);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // 로컬 파일 헤더 서명
    lh.setUint16(4, 20, true);           // 필요한 버전
    lh.setUint16(6, 0x0800, true);       // 플래그: bit 11 = UTF-8 파일명
    lh.setUint16(8, 0, true);            // 압축 방식 0 = store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, bytes.length, true);
    lh.setUint32(22, bytes.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // extra 길이
    parts.push(new Uint8Array(lh.buffer), nameBytes, bytes);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);   // 중앙 디렉터리 서명
    ch.setUint16(4, 20, true);           // 만든 버전
    ch.setUint16(6, 20, true);           // 필요한 버전
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, bytes.length, true);
    ch.setUint32(24, bytes.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);           // extra
    ch.setUint16(32, 0, true);           // 주석
    ch.setUint16(34, 0, true);           // 디스크 번호
    ch.setUint16(36, 0, true);           // 내부 속성
    ch.setUint32(38, 0, true);           // 외부 속성
    ch.setUint32(42, offset, true);      // 로컬 헤더 위치
    central.push(new Uint8Array(ch.buffer), nameBytes);

    offset += 30 + nameBytes.length + bytes.length;
    if (offset > 0xfffffffe) throw new Error('makeZip: zip 이 4GB 를 넘습니다.');
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);    // 끝 레코드 서명
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, used.size, true);
  end.setUint16(10, used.size, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
