/** Local capture via tshark (Wireshark CLI)—same engine as the GUI. */
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getDefaultButlorRoot } from './butlor-data-root.mjs';

const exec = promisify(cpExec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RING_MAX = 400;
const ALERTS_MAX = 120;

/** Curated training / reference links. */
export const SECURITY_LAB_RESOURCES = {
  disclaimer: '',
  resources: [
    {
      title: 'OWASP Web Security Testing Guide',
      url: 'https://owasp.org/www-project-web-security-testing-guide/',
      detail: 'Structured methodology for web app assessments.',
    },
    {
      title: 'NIST NICE Framework',
      url: 'https://www.nist.gov/itl/applied-cybersecurity/nice',
      detail: 'Workforce categories for cybersecurity roles and learning paths.',
    },
    {
      title: 'Wireshark documentation',
      url: 'https://www.wireshark.org/docs/',
      detail: 'Official docs for capture and analysis (pairs with Butler’s tshark monitor).',
    },
    {
      title: 'Kali Linux (offensive security)',
      url: 'https://www.kali.org/',
      detail: 'Pen-test distribution—VM, bare metal, or WSL.',
    },
    {
      title: 'TryHackMe',
      url: 'https://tryhackme.com/',
      detail: 'Guided rooms for defensive and offensive skills.',
    },
    {
      title: 'Hack The Box',
      url: 'https://www.hackthebox.com/',
      detail: 'Labs and hands-on practice.',
    },
  ],
};

/** Reference map of common Kali packages → official Kali tool pages. */
export const KALI_TOOLS_RESOURCES = {
  disclaimer: '',
  intro:
    'Butler runs what you tell him—ask in chat for `apt install …`, `pip install …`, `winget …`, or any shell on your machine. Below: official Kali tool pages (VM, cloud, WSL, or bare metal).',
  categories: [
    {
      title: 'Information gathering',
      detail: 'Reconnaissance and network mapping.',
      tools: [
        { name: 'nmap', url: 'https://www.kali.org/tools/nmap/', detail: 'Port scanning and service detection.' },
        { name: 'masscan', url: 'https://www.kali.org/tools/masscan/', detail: 'High-speed port scanner.' },
        { name: 'theHarvester', url: 'https://www.kali.org/tools/theharvester/', detail: 'OSINT: emails, hosts, subdomains.' },
        { name: 'dnsrecon', url: 'https://www.kali.org/tools/dnsrecon/', detail: 'DNS enumeration.' },
        { name: 'enum4linux', url: 'https://www.kali.org/tools/enum4linux/', detail: 'SMB/RPC enumeration.' },
      ],
    },
    {
      title: 'Web application',
      detail: 'Web application testing.',
      tools: [
        { name: 'Burp Suite', url: 'https://www.kali.org/tools/burpsuite/', detail: 'Proxy and manual testing (Community vs Pro).' },
        { name: 'nikto', url: 'https://www.kali.org/tools/nikto/', detail: 'Web server misconfiguration scanner.' },
        { name: 'sqlmap', url: 'https://www.kali.org/tools/sqlmap/', detail: 'SQL injection testing.' },
        { name: 'wpscan', url: 'https://www.kali.org/tools/wpscan/', detail: 'WordPress security scanner.' },
        { name: 'whatweb', url: 'https://www.kali.org/tools/whatweb/', detail: 'Web technology fingerprinting.' },
      ],
    },
    {
      title: 'Sniffing & spoofing',
      detail: 'Traffic capture and manipulation.',
      tools: [
        { name: 'Wireshark', url: 'https://www.kali.org/tools/wireshark/', detail: 'GUI protocol analyzer (pairs with Butler’s tshark monitor on the host).' },
        { name: 'tcpdump', url: 'https://www.kali.org/tools/tcpdump/', detail: 'CLI packet capture.' },
        { name: 'ettercap', url: 'https://www.kali.org/tools/ettercap/', detail: 'MITM framework.' },
        { name: 'responder', url: 'https://www.kali.org/tools/responder/', detail: 'LLMNR/NBT-NS poisoning.' },
      ],
    },
    {
      title: 'Vulnerability analysis',
      detail: 'Discovery and assessment tooling.',
      tools: [
        { name: 'nuclei', url: 'https://www.kali.org/tools/nuclei/', detail: 'Template-based scanner for web and infra.' },
        { name: 'legion', url: 'https://www.kali.org/tools/legion/', detail: 'Semi-automatic recon and scanning UI.' },
      ],
    },
    {
      title: 'Exploitation',
      detail: 'Exploit frameworks and payloads.',
      tools: [
        { name: 'Metasploit Framework', url: 'https://www.kali.org/tools/metasploit-framework/', detail: 'Exploit development, payloads, msfconsole.' },
        { name: 'searchsploit', url: 'https://www.kali.org/tools/exploitdb/', detail: 'Local search of Exploit-DB.' },
      ],
    },
    {
      title: 'Wireless',
      detail: '802.11 testing; needs compatible hardware.',
      tools: [
        { name: 'aircrack-ng', url: 'https://www.kali.org/tools/aircrack-ng/', detail: 'Wi‑Fi monitoring and key recovery (your hardware).' },
        { name: 'kismet', url: 'https://www.kali.org/tools/kismet/', detail: 'Wireless IDS / sniffing.' },
        { name: 'reaver', url: 'https://www.kali.org/tools/reaver/', detail: 'WPS attacks (many routers obsolete for this).' },
      ],
    },
    {
      title: 'Forensics & reverse engineering',
      detail: 'Disk, memory, and binary analysis.',
      tools: [
        { name: 'Autopsy', url: 'https://www.kali.org/tools/autopsy/', detail: 'Disk forensics GUI (Sleuth Kit front end).' },
        { name: 'The Sleuth Kit', url: 'https://www.kali.org/tools/sleuthkit/', detail: 'CLI disk forensics utilities.' },
        { name: 'Volatility 3', url: 'https://volatility3.readthedocs.io/', detail: 'Memory forensics framework (install via pip/apt in Kali).' },
        { name: 'binwalk', url: 'https://www.kali.org/tools/binwalk/', detail: 'Firmware and file carving.' },
        { name: 'foremost', url: 'https://www.kali.org/tools/foremost/', detail: 'File recovery by headers.' },
        { name: 'Ghidra', url: 'https://www.kali.org/tools/ghidra/', detail: 'NSA reverse-engineering suite.' },
        { name: 'radare2', url: 'https://www.kali.org/tools/radare2/', detail: 'CLI reversing and debugging.' },
      ],
    },
    {
      title: 'Password attacks',
      detail: 'Hash cracking and online guessing.',
      tools: [
        { name: 'hashcat', url: 'https://www.kali.org/tools/hashcat/', detail: 'GPU-accelerated hash cracking.' },
        { name: 'John the Ripper', url: 'https://www.kali.org/tools/john/', detail: 'CPU password/hash cracking.' },
        { name: 'hydra', url: 'https://www.kali.org/tools/hydra/', detail: 'Online password guessing / brute force.' },
      ],
    },
    {
      title: 'Reporting & social engineering',
      detail: 'Reporting and social-engineering tooling.',
      tools: [
        { name: 'Maltego', url: 'https://www.kali.org/tools/maltego/', detail: 'OSINT graphing (account may be required).' },
        { name: 'setoolkit', url: 'https://www.kali.org/tools/set/', detail: 'Social-engineering toolkit.' },
      ],
    },
  ],
  more: {
    title: 'Full tool index',
    url: 'https://www.kali.org/tools/',
    detail: 'Complete searchable listing on kali.org.',
  },
};

/** [Infoooze](https://github.com/devXprite/infoooze) — Node.js OSINT CLI (npm). Reference data for Butler Settings. */
export const INFOOOZE_RESOURCES = {
  intro:
    'Infoooze is a Node.js OSINT CLI: usernames, domains, IPs, mail hints, subdomains, ports, headers, DNS, GitHub, YouTube, and more. Requires Node.js 12+. Ask Butler in chat to run the install line below, then use `infoooze` or `infoze` in a terminal.',
  install_lines: [
    'npm install -g infoooze',
    '# Linux/macOS with permission issues: sudo npm install -g infoooze',
    '# Update: npm update -g infoooze',
    '# Remove: npm remove infoooze -g',
  ],
  links: [
    { title: 'GitHub — devXprite/infoooze', url: 'https://github.com/devXprite/infoooze' },
    { title: 'npm package', url: 'https://www.npmjs.com/package/infoooze' },
    { title: 'Documentation site', url: 'https://infoooze.js.org/' },
  ],
  features: [
    'Instagram recon & DP viewer',
    'Subdomain scanner',
    'Port scan',
    'User recon (social)',
    'Mail finder',
    'URL scanner',
    'Exif metadata',
    'Whois lookup',
    'IP lookup',
    'HTTP header info',
    'Website age',
    'DNS lookup',
    'User-agent lookup',
    'GitHub recon',
    'URL expander',
    'YouTube lookup',
    'Save results to file',
  ],
  cli_options: [
    { short: '-r', long: '--userrecon', desc: 'Username across social platforms' },
    { short: '-m', long: '--mailfinder', desc: 'Email associated with username or domain' },
    { short: '-u', long: '--useragent', desc: 'Parse a user-agent string' },
    { short: '-w', long: '--whoislookup', desc: 'Domain whois' },
    { short: '-i', long: '--instaRecon', desc: 'Instagram user info' },
    { short: '-p', long: '--iplookup', desc: 'IP address info' },
    { short: '-t', long: '--portscan', desc: 'Open ports' },
    { short: '-d', long: '--domainage', desc: 'How long the site has been registered' },
    { short: '-e', long: '--headerinfo', desc: 'HTTP headers' },
    { short: '-n', long: '--dnslookup', desc: 'DNS records' },
    { short: '-g', long: '--gitrecon', desc: 'GitHub user' },
    { short: '-s', long: '--subdomain', desc: 'Enumerate subdomains' },
    { short: '-x', long: '--exif', desc: 'Image Exif' },
    { short: '-a', long: '--webscan', desc: 'Analyze suspicious URLs' },
    { short: '-l', long: '--urlexpand', desc: 'Expand shortened URLs' },
    { short: '-y', long: '--youtubelookup', desc: 'YouTube video metadata' },
  ],
  examples: [
    { cmd: 'infoooze -h', note: 'Help / all flags' },
    { cmd: 'infoooze -w google.com', note: 'Whois' },
    { cmd: 'infoooze -s google.com', note: 'Subdomains' },
    { cmd: 'infoooze -p 8.8.8.8', note: 'IP lookup' },
    { cmd: 'infoooze -i instagram', note: 'Instagram recon (replace with target username)' },
  ],
};

let captureChild = null;
let captureStartedAt = null;
const eventRing = [];
const alertRing = [];
/** Monotonic ids for deduping notifications across snapshot polls. */
let alertIdSeq = 0;

function pushRing(arr, max, item) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function safeBpf(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length > 240) return '';
  if (!/^[\w\s.,\-:/()[\]\\"]+$/u.test(s)) return '';
  return s;
}

function publicishDst(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (ip.startsWith('10.')) return false;
  if (ip.startsWith('192.168.')) return false;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return false;
  }
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return false;
  return true;
}

function analyzeLine(fields) {
  const pad = [...fields];
  while (pad.length < 7) pad.push('');
  const [t, src, dst, tcpP, udpP, dns, sni] = pad;
  const alerts = [];
  const tcpPort = tcpP ? Number(tcpP) : null;
  const udpPort = udpP ? Number(udpP) : null;
  const dnsQ = (dns || '').trim();
  const sniS = (sni || '').trim();

  if (dnsQ.length > 45) {
    alerts.push({
      kind: 'long_dns_query',
      severity: 'low',
      detail: `Long DNS label (${dnsQ.length} chars) — possible tunneling or noisy client`,
    });
  }
  const uncommon = [4444, 5555, 1337, 6667];
  if (tcpPort && uncommon.includes(tcpPort) && dst && publicishDst(dst)) {
    alerts.push({
      kind: 'uncommon_tcp_port',
      severity: 'medium',
      detail: `TCP ${tcpPort} toward ${dst} (verify destination is expected)`,
    });
  }
  if (udpPort === 53 && dnsQ && dnsQ.length > 60) {
    alerts.push({
      kind: 'long_dns_udp',
      severity: 'low',
      detail: 'Unusually long DNS query on UDP/53',
    });
  }
  const lowDns = dnsQ.toLowerCase();
  if (/(pastebin|ngrok\.io|discordapp\.com\/api\/webhooks)/i.test(lowDns + sniS)) {
    alerts.push({
      kind: 'notable_keyword',
      severity: 'low',
      detail: 'DNS/SNI matched a commonly reviewed indicator — verify context',
    });
  }

  return alerts;
}

/** Shown when tshark cannot be resolved — keep in sync with .env.example. */
export const TSHARK_SETUP_HINT =
  'On Windows, Butler tries to install Wireshark automatically once via winget when you open Network monitor. ' +
  'If that failed: install from wireshark.org, run Butler as Administrator, or set BUTLER_TSHARK_PATH in .env to tshark.exe. ' +
  'Set BUTLER_SKIP_AUTO_WIRESHARK=1 to disable automatic install.';

function readEnvKeyFromFile(filePath, key) {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    const raw = readFileSync(filePath, 'utf8');
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const line of raw.split(/\r?\n/)) {
      const m = new RegExp(`^\\s*${esc}\\s*=\\s*(.*)$`).exec(line);
      if (!m) continue;
      let val = m[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      return val.trim();
    }
  } catch {
    /* */
  }
  return '';
}

/** Read BUTLER_TSHARK_PATH from common .env locations (cwd may not be repo root when Butler runs). */
function readButlerTsharkPathFromEnvFiles() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, 'ui', '.env'),
    path.join(getDefaultButlorRoot(), '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const fp of candidates) {
    const v = readEnvKeyFromFile(fp, 'BUTLER_TSHARK_PATH');
    if (v) {
      const norm = path.normalize(v);
      if (existsSync(norm)) return norm;
    }
  }
  return '';
}

async function tryTsharkFromWindowsRegistry() {
  if (process.platform !== 'win32') return null;
  const ps = [
    '$out=$null;',
    'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    '-ErrorAction SilentlyContinue |',
    "Where-Object { $_.DisplayName -match '^Wireshark' } |",
    'Select-Object -First 1 | ForEach-Object {',
    '  if ($_.InstallLocation) {',
    '    $t = Join-Path $_.InstallLocation.TrimEnd("\\") "tshark.exe"',
    '    if (Test-Path $t) { $out = $t }',
    '  }',
    '};',
    'if ($out) { Write-Output $out }',
  ].join(' ');
  try {
    const { stdout } = await exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(ps)}`, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const line = String(stdout || '')
      .trim()
      .split(/\r?\n/)[0];
    if (line) {
      const n = path.normalize(line.trim());
      if (existsSync(n)) return n;
    }
  } catch {
    /* */
  }
  return null;
}

function tryFindTsharkWindowsScan() {
  const roots = [
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const direct = path.join(root, 'Wireshark', 'tshark.exe');
    if (existsSync(direct)) return direct;
    try {
      const names = readdirSync(root);
      for (const name of names) {
        if (!/^wireshark/i.test(name)) continue;
        const p = path.join(root, name, 'tshark.exe');
        if (existsSync(p)) return p;
      }
    } catch {
      /* */
    }
  }
  return null;
}

/** Single-flight: first failure on Windows triggers winget once per process (unless BUTLER_SKIP_AUTO_WIRESHARK=1). */
let wiresharkWingetPromise = null;

function shouldSkipAutoWiresharkInstall() {
  return ['1', 'true', 'yes'].includes(String(process.env.BUTLER_SKIP_AUTO_WIRESHARK || '').trim().toLowerCase());
}

async function resolveTsharkPathNoAuto() {
  const fromEnv = String(process.env.BUTLER_TSHARK_PATH || '').trim();
  if (fromEnv) {
    const norm = path.normalize(fromEnv);
    if (existsSync(norm)) return norm;
  }
  const fromFiles = readButlerTsharkPathFromEnvFiles();
  if (fromFiles) return fromFiles;

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Wireshark', 'tshark.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Wireshark', 'tshark.exe'),
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Wireshark', 'tshark.exe')
            : '',
        ]
      : ['/usr/bin/tshark', '/usr/local/bin/tshark', '/opt/homebrew/bin/tshark'];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  if (process.platform === 'win32') {
    const scanned = tryFindTsharkWindowsScan();
    if (scanned) return scanned;
    const reg = await tryTsharkFromWindowsRegistry();
    if (reg) return reg;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where.exe tshark' : 'command -v tshark';
    const { stdout } = await exec(cmd, { windowsHide: true, maxBuffer: 1024 * 1024 });
    const lines = String(stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const n = path.normalize(line);
      if (n && existsSync(n)) return n;
    }
  } catch {
    /* */
  }
  return null;
}

/**
 * Resolve tshark.exe. On Windows, if not found, runs `winget install Wireshark` once (shared promise), then searches again.
 */
export async function resolveTsharkPath() {
  const first = await resolveTsharkPathNoAuto();
  if (first) return first;
  if (process.platform !== 'win32' || shouldSkipAutoWiresharkInstall()) return null;
  if (!wiresharkWingetPromise) {
    wiresharkWingetPromise = installWiresharkWinget().catch(() => ({ ok: false }));
  }
  await wiresharkWingetPromise;
  return await resolveTsharkPathNoAuto();
}

function probePlatformFlags() {
  return { can_install_winget: process.platform === 'win32' };
}

/** Fast check for GET /status — no winget (avoid multi-minute blocking on every refresh). */
export async function probeTsharkForStatusRow() {
  const exe = await resolveTsharkPathNoAuto();
  if (!exe) {
    return {
      ok: false,
      detail:
        'tshark not found — open Settings → Network monitor. On Windows, opening that section runs setup (winget) automatically; or install Wireshark and set BUTLER_TSHARK_PATH.',
    };
  }
  try {
    const { stdout, stderr } = await exec(`"${exe.replace(/"/g, '\\"')}" -v`, {
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const ver = String(stdout || stderr || '')
      .split(/\r?\n/)
      .find((l) => /TShark|Tshark|Wireshark/i.test(l));
    return {
      ok: true,
      detail: (ver || exe).slice(0, 220),
    };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 220) };
  }
}

export async function probeTshark() {
  const flags = probePlatformFlags();
  const before = await resolveTsharkPathNoAuto();
  const exe = before || (await resolveTsharkPath());
  const auto_wireshark = !before && !!exe;
  if (!exe) {
    return {
      ok: false,
      error: 'tshark not found.',
      setup_hint: TSHARK_SETUP_HINT,
      auto_wireshark_attempted: process.platform === 'win32' && !shouldSkipAutoWiresharkInstall(),
      ...flags,
    };
  }
  try {
    const { stdout, stderr } = await exec(`"${exe.replace(/"/g, '\\"')}" -v`, {
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const ver = String(stdout || stderr || '')
      .split(/\r?\n/)
      .find((l) => /TShark|Tshark|Wireshark/i.test(l));
    return {
      ok: true,
      path: exe,
      version: ver || 'tshark OK',
      auto_wireshark,
      ...flags,
    };
  } catch (e) {
    return { ok: false, path: exe, error: String(e?.message || e).slice(0, 200), ...flags };
  }
}

export async function listInterfaces() {
  const exe = await resolveTsharkPath();
  if (!exe) {
    return {
      ok: false,
      error: 'tshark not found.',
      setup_hint: TSHARK_SETUP_HINT,
      can_install_winget: process.platform === 'win32',
      interfaces: [],
    };
  }
  try {
    const { stdout } = await exec(`"${exe.replace(/"/g, '\\"')}" -D`, {
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const interfaces = [];
    for (const line of lines) {
      const m = /^(\d+)\.\s+(.+)$/.exec(line);
      if (m) {
        interfaces.push({ index: m[1], label: m[2].trim() });
      }
    }
    return { ok: true, path: exe, interfaces };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 220), interfaces: [] };
  }
}

export function getMonitorState() {
  return {
    running: captureChild != null && !captureChild.killed,
    startedAt: captureStartedAt,
    eventCount: eventRing.length,
    alertCount: alertRing.length,
  };
}

export function getSnapshot({ maxEvents = 80, maxAlerts = 40 } = {}) {
  return {
    ...getMonitorState(),
    events: eventRing.slice(-maxEvents),
    alerts: alertRing.slice(-maxAlerts),
  };
}

/** Clear capture rings before a fresh quick-scan (does not stop tshark). */
export function clearMonitorBuffers() {
  eventRing.length = 0;
  alertRing.length = 0;
}

function summarizeAlerts(alerts) {
  const high = alerts.filter((a) => String(a.severity).toLowerCase() === 'high').length;
  const medium = alerts.filter((a) => String(a.severity).toLowerCase() === 'medium').length;
  const low = alerts.filter((a) => String(a.severity).toLowerCase() === 'low').length;
  let headline = '';
  if (alerts.length === 0) {
    headline = 'No heuristic alerts in this window. Traffic was observed; nothing matched suspicious patterns.';
  } else if (high > 0) {
    headline = `${high} high-severity signal(s) — review immediately.`;
  } else if (medium > 0) {
    headline = `${medium} medium-severity finding(s) worth verifying (unusual ports or destinations).`;
  } else {
    headline = `${low} low-severity indicator(s) — often benign; review if unexpected.`;
  }
  return { high, medium, low, total: alerts.length, headline };
}

/**
 * Pick default capture interface: prefer Ethernet / Wi‑Fi by name, else first listed, else "1".
 */
export function pickDefaultInterface(interfaces) {
  const list = Array.isArray(interfaces) ? interfaces : [];
  if (!list.length) return { iface: '1', label: 'default (#1)' };
  const prefer = list.find((x) => /ethernet|wi-?fi|wlan|802\.11|wireless/i.test(String(x.label || '')));
  const row = prefer || list[0];
  return { iface: String(row.index || '1').trim() || '1', label: String(row.label || '').trim() || `iface ${row.index}` };
}

/**
 * One-shot: probe tshark, clear buffers, capture for `seconds`, return alerts + summary, then stop.
 */
export async function quickScan({ iface, bpf, seconds } = {}) {
  const probe = await probeTshark();
  if (!probe.ok) {
    return {
      ok: false,
      error: probe.error || 'tshark not available',
      setup_hint: probe.setup_hint,
      probe,
    };
  }

  let ifaceStr = iface != null ? String(iface).trim() : '';
  let ifaceLabel = ifaceStr;
  if (!ifaceStr) {
    const listed = await listInterfaces();
    if (listed.ok && listed.interfaces?.length) {
      const picked = pickDefaultInterface(listed.interfaces);
      ifaceStr = picked.iface;
      ifaceLabel = picked.label;
    } else {
      ifaceStr = String(process.env.BUTLER_NETWORK_INTERFACE || '1').trim() || '1';
      ifaceLabel = ifaceStr;
    }
  }

  const sec = Math.min(45, Math.max(5, Number(seconds) || 12));
  clearMonitorBuffers();
  const started = await startCapture({ iface: ifaceStr, bpf: bpf || undefined });
  if (!started || !started.ok) {
    return {
      ok: false,
      error: started?.error || 'Could not start capture',
      probe,
      iface: ifaceStr,
      ifaceLabel,
    };
  }

  await new Promise((r) => setTimeout(r, sec * 1000));
  const snap = getSnapshot({ maxEvents: 160, maxAlerts: 100 });
  stopCapture();

  const alerts = snap.alerts || [];
  const suspicious = summarizeAlerts(alerts);
  return {
    ok: true,
    probe,
    seconds: sec,
    iface: ifaceStr,
    ifaceLabel,
    bpf: started.bpf ?? null,
    eventsSeen: (snap.events || []).length,
    alertCount: alerts.length,
    suspicious,
    alerts: alerts.slice(-80),
    events: (snap.events || []).slice(-40),
    disclaimer: 'Heuristic only—not antivirus. False positives are normal.',
  };
}

export function stopCapture() {
  if (!captureChild) return { ok: true, message: 'Already stopped' };
  try {
    captureChild.kill();
  } catch {
    /* */
  }
  captureChild = null;
  captureStartedAt = null;
  return { ok: true, message: 'Stopped' };
}

export function startCapture({ iface, bpf } = {}) {
  stopCapture();
  const ifaceStr = String(iface || process.env.BUTLER_NETWORK_INTERFACE || '1').trim() || '1';
  const bpfSafe = safeBpf(bpf);

  return (async () => {
    const exe = await resolveTsharkPath();
    if (!exe) {
      return { ok: false, error: 'tshark not found.', setup_hint: TSHARK_SETUP_HINT };
    }
    const args = [
      '-i',
      ifaceStr,
      '-l',
      '-n',
      '-q',
      '-T',
      'fields',
      '-e',
      'frame.time',
      '-e',
      'ip.src',
      '-e',
      'ip.dst',
      '-e',
      'tcp.dstport',
      '-e',
      'udp.dstport',
      '-e',
      'dns.qry.name',
      '-e',
      'tls.handshake.extensions_server_name',
      '-E',
      'separator=\t',
      '-E',
      'quote=n',
      '-E',
      'header=n',
    ];
    if (bpfSafe) {
      args.push('-f', bpfSafe);
    }

    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    captureChild = child;
    captureStartedAt = new Date().toISOString();

    const onChunk = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('\t');
        const ev = {
          t: new Date().toISOString(),
          raw: trimmed.slice(0, 500),
          frameTime: parts[0] || '',
          src: parts[1] || '',
          dst: parts[2] || '',
          tcpDst: parts[3] || '',
          udpDst: parts[4] || '',
          dns: parts[5] || '',
          sni: parts[6] || '',
        };
        pushRing(eventRing, RING_MAX, ev);
        for (const a of analyzeLine(parts)) {
          pushRing(alertRing, ALERTS_MAX, {
            id: ++alertIdSeq,
            t: new Date().toISOString(),
            ...a,
            context: { src: ev.src, dst: ev.dst, dns: ev.dns, sni: ev.sni },
          });
        }
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', (d) => {
      const s = d.toString().trim();
      if (s) {
        pushRing(eventRing, RING_MAX, {
          t: new Date().toISOString(),
          raw: `[tshark stderr] ${s.slice(0, 400)}`,
          frameTime: '',
          src: '',
          dst: '',
          tcpDst: '',
          udpDst: '',
          dns: '',
          sni: '',
        });
      }
    });
    child.on('close', (code) => {
      if (captureChild === child) {
        captureChild = null;
        captureStartedAt = null;
      }
      pushRing(eventRing, RING_MAX, {
        t: new Date().toISOString(),
        raw: `[tshark exit ${code ?? '?'}]`,
        frameTime: '',
        src: '',
        dst: '',
        tcpDst: '',
        udpDst: '',
        dns: '',
        sni: '',
      });
    });
    child.on('error', (err) => {
      pushRing(eventRing, RING_MAX, {
        t: new Date().toISOString(),
        raw: `[tshark error] ${String(err?.message || err).slice(0, 300)}`,
        frameTime: '',
        src: '',
        dst: '',
        tcpDst: '',
        udpDst: '',
        dns: '',
        sni: '',
      });
    });

    return { ok: true, message: 'Capture started', iface: ifaceStr, bpf: bpfSafe || null };
  })();
}

function wingetOutputLooksSuccessful(log) {
  const t = String(log || '').toLowerCase();
  return /already installed|no applicable upgrade|no newer package versions are available|successfully installed|installation completed/i.test(
    t,
  );
}

/** Windows: install Wireshark via winget (App Installer). May require elevation or user approval. */
export async function installWiresharkWinget() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Automatic install is only available on Windows.' };
  }
  const id = 'WiresharkFoundation.Wireshark';
  const cmd = `winget install -e --id ${id} --accept-package-agreements --accept-source-agreements`;
  try {
    const { stdout, stderr } = await exec(cmd, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 600000,
    });
    const log = String(stdout || stderr || '');
    return {
      ok: true,
      message:
        'winget finished. If Butler still cannot find tshark, restart the app once (PATH refresh) or set BUTLER_TSHARK_PATH.',
      log: log.slice(0, 8000),
    };
  } catch (e) {
    const stderr = e?.stderr != null ? String(e.stderr) : '';
    const stdout = e?.stdout != null ? String(e.stdout) : '';
    const combined = (stdout + stderr + String(e?.message || e)).slice(0, 4000);
    if (wingetOutputLooksSuccessful(combined)) {
      return {
        ok: true,
        message: 'Wireshark appears to be present (winget reported no new install needed).',
        log: combined.slice(0, 8000),
      };
    }
    return {
      ok: false,
      error: combined.slice(0, 2500),
      hint:
        'If winget is unavailable, run Butler as Administrator once, or install Wireshark from https://www.wireshark.org/ — then set BUTLER_TSHARK_PATH if needed.',
    };
  }
}

process.on('SIGINT', () => {
  stopCapture();
});
process.on('SIGTERM', () => {
  stopCapture();
});
