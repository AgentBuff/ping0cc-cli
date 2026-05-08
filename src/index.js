const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const chalk = require('chalk');
const Table = require('cli-table3');

const execFileAsync = promisify(execFile);
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

function firstNonEmpty(values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

function commandOnPath(command) {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function resolveCurlExecutable() {
  const executable = firstNonEmpty([commandOnPath('curl'), '/usr/bin/curl']);
  if (!executable) {
    throw new Error('未找到 curl，无法调用 ping0.cc 官方接口');
  }
  return executable;
}

function normalizeProxyUrl(value) {
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function maskProxyValue(value) {
  try {
    const proxyUrl = new URL(normalizeProxyUrl(value));
    if (proxyUrl.username) proxyUrl.username = '***';
    if (proxyUrl.password) proxyUrl.password = '***';
    return proxyUrl.toString();
  } catch {
    return value;
  }
}

function getActiveProxySettings() {
  return PROXY_ENV_KEYS.map((key) => ({ key, value: process.env[key] }))
    .filter(({ value }) => typeof value === 'string' && value.trim())
    .map(({ key, value }) => ({ key, value: value.trim() }));
}

function describeProxyUsage() {
  const active = getActiveProxySettings();
  if (active.length === 0) {
    return '未检测到 HTTP(S)_PROXY/ALL_PROXY，按直连方式访问';
  }
  return active.map(({ key, value }) => `${key}=${maskProxyValue(value)}`).join(' | ');
}

function buildDirectEnv() {
  const env = { ...process.env };
  for (const key of [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS]) {
    delete env[key];
  }
  return env;
}

function formatCurlError(error, fallbackMessage) {
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) {
    return `${fallbackMessage}: ${stderr}`;
  }
  return fallbackMessage;
}

function isCurlCertificateError(error) {
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  return /SSL certificate problem|certificate has expired|self-signed certificate|unable to get local issuer certificate|certificate verify failed/i.test(stderr);
}

function trimCurlOutput(stdout) {
  return String(stdout || '').replace(/\r/g, '').trim();
}

async function runCurl(url, { direct = false, timeoutSeconds = 15 } = {}) {
  const curlPath = resolveCurlExecutable();
  const baseArgs = [
    '-fsSL',
    '--connect-timeout',
    String(Math.min(timeoutSeconds, 10)),
    '--max-time',
    String(timeoutSeconds),
  ];

  if (direct) {
    baseArgs.push('--noproxy', '*');
  }

  const env = direct ? buildDirectEnv() : process.env;

  try {
    const { stdout } = await execFileAsync(curlPath, [...baseArgs, url], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    });
    return {
      output: trimCurlOutput(stdout),
      insecureTransport: false,
    };
  } catch (error) {
    if (isCurlCertificateError(error)) {
      try {
        const { stdout } = await execFileAsync(curlPath, [...baseArgs, '--insecure', url], {
          encoding: 'utf8',
          env,
          maxBuffer: 1024 * 1024,
        });
        return {
          output: trimCurlOutput(stdout),
          insecureTransport: true,
        };
      } catch (retryError) {
        throw new Error(formatCurlError(retryError, `调用 ping0.cc 接口失败: ${url}`));
      }
    }
    throw new Error(formatCurlError(error, `调用 ping0.cc 接口失败: ${url}`));
  }
}

function parseGeoOutput(output) {
  const lines = (output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 4) {
    throw new Error('ping0.cc/geo 返回格式不符合预期');
  }

  return {
    ip: lines[0],
    location: lines[1],
    asn: lines[2],
    organization: lines[3],
    source: 'https://ping0.cc/geo',
  };
}

function parsePaidApiOutput(output) {
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    throw new Error('ping0.cc 指定 IP API 返回了无法解析的内容');
  }

  if (!data || !data.ip) {
    throw new Error('ping0.cc 指定 IP API 返回数据不完整');
  }

  return {
    ip: data.ip,
    location: data.location || '',
    country: data.country || '',
    province: data.province || '',
    city: data.city || '',
    asn: data.asn || '',
    asnName: data.asnname || '',
    organization: data.org || '',
    riskScore: typeof data.iprisk === 'number' ? `${data.iprisk}%` : '',
    nativeIp: typeof data.isnative === 'boolean' ? (data.isnative ? '是' : '否') : '',
    isIdc: typeof data.isidc === 'boolean' ? (data.isidc ? '是' : '否') : '',
    asnType: data.asntype || '',
    orgType: data.orgtype || '',
    source: 'https://ping0.cc/apiloc',
  };
}

function parseSavedResult(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('文件内容为空');
  }

  if (trimmed.startsWith('{')) {
    return {
      mode: 'specified-ip',
      ...parsePaidApiOutput(trimmed),
      proxyStatus: '文件导入结果',
      proxyInfo: '文件导入结果',
    };
  }

  return {
    mode: 'current-exit',
    ...parseGeoOutput(trimmed),
    proxyStatus: '文件导入结果',
    proxyInfo: '文件导入结果',
    effectiveExitIp: parseGeoOutput(trimmed).ip,
    directExitIp: '',
  };
}

async function fetchCurrentExitGeo({ direct = false } = {}) {
  const { output, insecureTransport } = await runCurl('https://ping0.cc/geo', {
    direct,
    timeoutSeconds: 15,
  });
  return {
    ...parseGeoOutput(output),
    insecureTransport,
  };
}

async function fetchSpecifiedIp(ip) {
  const apiKey = firstNonEmpty([process.env.P0CC_API_KEY]);
  if (!apiKey) {
    throw new Error('免费接口只支持检测当前命令行出口 IP；如需查询指定 IP，请配置 P0CC_API_KEY');
  }

  const url = `https://ping0.cc/apiloc/apikey(${apiKey})/ip(${ip})`;
  const { output, insecureTransport } = await runCurl(url, { timeoutSeconds: 20 });
  return {
    ...parsePaidApiOutput(output),
    insecureTransport,
  };
}

function mergeSources(primary, secondary) {
  if (!primary) return secondary || '';
  if (!secondary || primary === secondary) return primary;
  return `${primary} + ${secondary}`;
}

async function enrichCurrentExitResult(current) {
  const apiKey = firstNonEmpty([process.env.P0CC_API_KEY]);
  if (!apiKey) {
    return {
      ...current,
      purityNotice: '免费接口仅提供 IP/位置/ASN/组织；配置 P0CC_API_KEY 可补全风控值/原生 IP/机房 IP 等纯净度字段',
    };
  }

  try {
    const detail = await fetchSpecifiedIp(current.ip);
    return {
      ...current,
      ...detail,
      effectiveExitIp: current.ip,
      source: mergeSources(current.source, detail.source),
      insecureTransport: Boolean(current.insecureTransport || detail.insecureTransport),
      purityNotice: '已通过 P0CC_API_KEY 补全纯净度字段',
    };
  } catch (error) {
    return {
      ...current,
      purityNotice: `已检测到 P0CC_API_KEY，但补全纯净度字段失败：${error.message}`,
    };
  }
}

function buildProxyStatus({ hasProxy, currentIp, directIp, targetIp }) {
  if (targetIp) return '已跳过，仅查询指定 IP';
  if (!hasProxy) return '未设置代理，当前结果为直连出口';
  if (!currentIp || !directIp) return '已设置代理，但未拿到完整对比结果';
  if (currentIp !== directIp) return '代理已生效，出口 IP 已变化';
  return '已设置代理，但出口 IP 未变化';
}

function riskColor(value) {
  if (!value) return chalk.gray('N/A');
  const score = parseInt(value, 10);
  if (Number.isNaN(score)) return value;
  if (score <= 15) return chalk.green(value);
  if (score <= 25) return chalk.greenBright(value);
  if (score <= 40) return chalk.yellow(value);
  if (score <= 50) return chalk.hex('#FFAA00')(value);
  if (score <= 70) return chalk.red(value);
  return chalk.redBright(value);
}

function renderTable(head, rows, widths) {
  const table = new Table({
    head,
    colWidths: widths,
    wordWrap: true,
    style: {
      head: [],
      border: [],
    },
  });

  rows.forEach((row) => table.push(row));
  return table.toString();
}

function render(data) {
  const terminalWidth = Math.max(process.stdout.columns || 100, 80);
  const summaryWidth = Math.max(terminalWidth - 24, 40);
  const rows = [];

  rows.push([chalk.cyan('检测目标'), data.mode === 'specified-ip' ? '指定 IP' : '当前命令行出口']);
  rows.push([chalk.cyan('命令行代理'), data.proxyInfo || '未提供']);
  rows.push([chalk.cyan('代理结论'), data.proxyStatus || 'N/A']);
  if (data.effectiveExitIp) {
    rows.push([chalk.cyan('当前出口 IP'), data.effectiveExitIp]);
  }
  if (data.mode !== 'specified-ip') {
    rows.push([chalk.cyan('直连出口 IP'), data.directExitIp || chalk.gray('未采集')]);
  }
  rows.push([chalk.cyan('IP 地址'), data.ip || chalk.gray('N/A')]);
  rows.push([chalk.cyan('IP 位置'), data.location || chalk.gray('N/A')]);
  if (data.purityNotice) {
    rows.push([chalk.cyan('纯净度数据'), data.purityNotice]);
  }
  if (data.country || data.province || data.city) {
    rows.push([
      chalk.cyan('行政区'),
      [data.country, data.province, data.city].filter(Boolean).join(' / ') || chalk.gray('N/A'),
    ]);
  }
  rows.push([chalk.cyan('ASN'), data.asn || chalk.gray('N/A')]);
  if (data.asnName) {
    rows.push([chalk.cyan('ASN 名称'), data.asnName]);
  }
  rows.push([chalk.cyan('组织'), data.organization || chalk.gray('N/A')]);
  if (data.riskScore) {
    rows.push([chalk.cyan('风控值'), riskColor(data.riskScore)]);
  }
  if (data.nativeIp) {
    rows.push([chalk.cyan('原生 IP'), data.nativeIp]);
  }
  if (data.isIdc) {
    rows.push([chalk.cyan('机房 IP'), data.isIdc]);
  }
  if (data.asnType) {
    rows.push([chalk.cyan('ASN 类型'), data.asnType]);
  }
  if (data.orgType) {
    rows.push([chalk.cyan('组织类型'), data.orgType]);
  }
  rows.push([chalk.cyan('数据来源'), data.source || chalk.gray('N/A')]);

  return ['' , chalk.bold.cyan('Ping0.cc 命令行代理检测'), '', renderTable(['字段', '结果'], rows, [18, summaryWidth]), ''].join('\n');
}

async function run(targetIp) {
  const activeProxySettings = getActiveProxySettings();
  const proxyInfo = describeProxyUsage();

  console.log(chalk.gray('\n  ⏳ 正在从 ping0.cc 获取检测结果...'));
  console.log(chalk.gray(`  → 检测目标: ${targetIp ? `指定 IP ${targetIp}` : '当前命令行出口 IP'}`));
  console.log(chalk.gray(`  → 命令行代理: ${proxyInfo}`));

  if (targetIp) {
    console.log(chalk.gray(`  → 调用指定 IP API 查询 ${targetIp} ...`));
    const result = await fetchSpecifiedIp(targetIp);
    if (result.insecureTransport) {
      console.log(chalk.yellow('  ⚠️ ping0.cc TLS 证书校验失败，已自动回退到不校验证书的请求'));
    }
    result.mode = 'specified-ip';
    result.proxyInfo = proxyInfo;
    result.proxyStatus = buildProxyStatus({
      hasProxy: activeProxySettings.length > 0,
      targetIp,
    });
    console.log(render(result));
    return;
  }

  console.log(chalk.gray('  → 读取当前命令行出口的 ping0 结果...'));
  const current = await fetchCurrentExitGeo({ direct: false });

  console.log(chalk.gray('  → 读取直连出口作为对比基线...'));
  let direct = { ip: '' };
  try {
    direct = await fetchCurrentExitGeo({ direct: true });
  } catch {
    direct = { ip: '' };
  }

  const result = await enrichCurrentExitResult({
    mode: 'current-exit',
    proxyInfo,
    proxyStatus: buildProxyStatus({
      hasProxy: activeProxySettings.length > 0,
      currentIp: current.ip,
      directIp: direct.ip,
    }),
    effectiveExitIp: current.ip,
    directExitIp: direct.ip,
    ...current,
  });

  if (result.insecureTransport || direct.insecureTransport) {
    console.log(chalk.yellow('  ⚠️ ping0.cc TLS 证书校验失败，已自动回退到不校验证书的请求'));
  }

  console.log(render(result));
}

module.exports = {
  run,
  render,
  parseSavedResult,
  parseHTML: parseSavedResult,
};