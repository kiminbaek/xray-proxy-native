// xray 分享链接解析模块（v1.5.0+ P1-2）
// 支持 vless / vmess / trojan / ss / base64 v2rayN 订阅
// v1.6.0+ 抽离为独立模块

// vmess://base64(JSON)
function parseVmess(link) {
  const b64 = link.slice(8);
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  return {
    tag: json.ps || 'vmess-' + Date.now(),
    protocol: 'vmess',
    settings: {
      vnext: [{
        address: json.add, port: parseInt(json.port),
        users: [{ id: json.id, alterId: parseInt(json.aid || 0), security: json.type || 'auto' }]
      }]
    },
    streamSettings: {
      network: json.net || 'tcp',
      security: json.tls || 'none',
      wsSettings: json.net === 'ws' ? { path: json.path, headers: { Host: json.host } } : undefined,
      tcpSettings: json.net === 'tcp' && json.type === 'http' ? { header: { request: { headers: { Host: json.host } } } } : undefined
    }
  };
}

// vless://uuid@host:port?params#tag
function parseVless(link) {
  const u = new URL(link);
  const tag = decodeURIComponent(u.hash.slice(1)) || 'vless-' + u.hostname;
  const params = u.searchParams;
  const node = {
    tag,
    protocol: 'vless',
    settings: {
      vnext: [{
        address: u.hostname, port: parseInt(u.port),
        users: [{ id: u.username, encryption: params.get('encryption') || 'none', flow: params.get('flow') || undefined }]
      }]
    },
    streamSettings: { network: params.get('type') || 'tcp', security: params.get('security') || 'none' }
  };
  const net = params.get('type') || 'tcp';
  if (net === 'ws') {
    node.streamSettings.wsSettings = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
  } else if (net === 'grpc') {
    node.streamSettings.grpcSettings = { serviceName: params.get('serviceName') || '' };
  }
  else if (net === 'xhttp') {
    // v1.15.2+ vless xhttp 支持
    const xh = { path: params.get('path') || '/' };
    const host = params.get('host');
    if (host) xh.host = host;
    node.streamSettings.xhttpSettings = xh;
  }
  const sec = params.get('security');
  if (sec === 'tls') {
    const sni = params.get('sni') || params.get('peer') || u.hostname;
    node.streamSettings.tlsSettings = { serverName: sni, allowInsecure: params.get('allowInsecure') === '1' };
  } else if (sec === 'reality') {
    // v1.15.2+ vless reality 支持
    const sni = params.get('sni') || u.hostname;
    node.streamSettings.realitySettings = {
      serverName: sni,
      fingerprint: params.get('fp') || 'chrome',
      publicKey: params.get('pbk') || '',
      shortId: params.get('sid') || '',
      show: false
    };
  }
  return node;
}

// trojan://password@host:port?params#tag
function parseTrojan(link) {
  const u = new URL(link);
  const tag = decodeURIComponent(u.hash.slice(1)) || 'trojan-' + u.hostname;
  const params = u.searchParams;
  return {
    tag,
    protocol: 'trojan',
    settings: { servers: [{ address: u.hostname, port: parseInt(u.port), password: decodeURIComponent(u.username) }] },
    streamSettings: {
      network: params.get('type') || 'tcp',
      security: 'tls',
      tlsSettings: { serverName: params.get('sni') || u.hostname, allowInsecure: params.get('allowInsecure') === '1' }
    }
  };
}

// ss://base64(method:password)@host:port#tag
// 也支持 ss://method:password@host:port（明文）
function parseSs(link) {
  const rest = link.slice(5);
  const hashIdx = rest.indexOf('#');
  const tagPart = hashIdx > 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : '';
  const main = hashIdx > 0 ? rest.slice(0, hashIdx) : rest;
  const atIdx = main.lastIndexOf('@');
  let userInfo, hostPort;
  if (atIdx > 0) {
    userInfo = main.slice(0, atIdx);
    hostPort = main.slice(atIdx + 1);
  } else {
    // 整个 base64
    const decoded = Buffer.from(main, 'base64').toString('utf-8');
    const ai = decoded.lastIndexOf('@');
    userInfo = decoded.slice(0, ai);
    hostPort = decoded.slice(ai + 1);
  }
  // userInfo 可能是 method:password 或 base64(method:password)
  let method, password;
  if (userInfo.includes(':')) {
    [method, password] = userInfo.split(':');
    try { password = Buffer.from(password, 'base64').toString('utf-8'); } catch (_) {}
  } else {
    const dec = Buffer.from(userInfo, 'base64').toString('utf-8');
    const idx = dec.indexOf(':');
    method = dec.slice(0, idx);
    password = dec.slice(idx + 1);
  }
  const [address, port] = hostPort.split(':');
  return {
    tag: tagPart || 'ss-' + address,
    protocol: 'shadowsocks',
    settings: { servers: [{ address, port: parseInt(port), method, password, level: 1 }] }
  };
}

// 解析一条分享链接
// 返回: { tag, protocol, settings, streamSettings } | { error: '原因' } | null（空）
function parseShareLink(link) {
  if (!link) return null;
  link = link.trim();
  if (!link) return null;

  try {
    if (link.startsWith('vmess://')) return parseVmess(link);
    if (link.startsWith('vless://')) return parseVless(link);
    if (link.startsWith('trojan://')) return parseTrojan(link);
    if (link.startsWith('ss://')) return parseSs(link);
  } catch (e) {
    return { error: (link.split('://')[0] || '未知') + ' 解析失败: ' + e.message };
  }
  return { error: '不支持的协议或格式错误' };
}

module.exports = {
  parseShareLink,
  parseVmess,
  parseVless,
  parseTrojan,
  parseSs
};
