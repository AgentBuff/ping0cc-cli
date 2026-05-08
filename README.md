# ping0cc-cli

一个基于 ping0.cc 官方接口的命令行工具，用 `p0cc` 直接检测当前命令行出口 IP，并判断当前终端代理是否生效。

## 安装

```bash
npm install -g ping0cc-cli
```

安装后可直接使用：

```bash
p0cc
```

## 功能

- 无参执行 `p0cc` 时：
  - 调用 `https://ping0.cc/geo` 获取当前命令行出口的 IP、位置、ASN、组织信息
  - 再用清空代理环境变量后的直连结果做对比
  - 以 TUI table 输出“当前出口 IP / 直连出口 IP / 代理结论”等信息
  - 如果配置了 `P0CC_API_KEY`，会继续补全风控值、原生 IP、机房 IP 等纯净度字段
- 指定 IP 执行 `p0cc <ip>` 时：
  - 需要配置付费 API Key：`P0CC_API_KEY`

## 纯净度字段说明

`ping0.cc/geo` 免费接口只返回 4 项基础信息：

- IP 地址
- 位置信息
- ASN
- 组织信息

如果你希望在 `p0cc` 默认无参模式下也看到风控值、原生 IP、机房 IP 等纯净度字段，需要配置：

```bash
export P0CC_API_KEY="your_api_key"
p0cc
```

## 用法

```bash
p0cc
p0cc 8.8.8.8
```

## 代理环境变量

默认会继承当前终端中的以下环境变量：

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `ALL_PROXY`

如果这些变量存在，`p0cc` 会把当前出口结果与直连基线做对比，帮助判断代理是否实际生效。

## TLS 证书回退

如果你的代理链路或 ping0.cc 当前证书状态导致 `curl` 报 TLS / 证书校验错误，`p0cc` 会自动对 ping0.cc 请求回退到 `--insecure`，避免因为证书链问题直接失败。

## 指定 IP 查询

免费接口只支持当前出口 IP。若要查询指定 IP，需要先配置：

```bash
export P0CC_API_KEY="your_api_key"
p0cc 8.8.8.8
```

## 开发

```bash
npm install
npm start
```