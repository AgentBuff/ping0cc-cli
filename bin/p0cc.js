#!/usr/bin/env node

const { run, parseSavedResult, render } = require('../src/index');
const fs = require('fs');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  p0cc - ping0.cc IP 纯净度检测 CLI

  用法:
    p0cc              自动检测当前命令行出口 IP
    p0cc <ip>         查询指定 IP（需配置 P0CC_API_KEY）
    p0cc --help       显示帮助

  说明:
    默认会继承 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 等代理环境变量
    无参模式使用 ping0.cc 官方免费接口 ping0.cc/geo
    若配置 P0CC_API_KEY，会自动补全当前出口 IP 的纯净度字段
    若 ping0.cc TLS 校验失败，会自动回退到不校验证书的请求

  示例:
    p0cc
    p0cc 8.8.8.8
`);
  process.exit(0);
}

// Debug: load from saved geo/json response file
if (args.includes('--file')) {
  const idx = args.indexOf('--file');
  const file = args[idx + 1];
  if (!file) {
    console.error('请指定保存结果文件路径');
    process.exit(1);
  }
  const content = fs.readFileSync(file, 'utf8');
  const data = parseSavedResult(content);
  console.log(render(data));
  process.exit(0);
}

const ip = args.find((a) => !a.startsWith('-')) || null;

run(ip).catch((err) => {
  console.error(`\n  ❌ ${err.message}\n`);
  process.exit(1);
});
