# NodeGet SingBox Panel

NodeGet Dashboard 扩展，用于在节点上安装和管理 sing-box 配置。

## 支持

- 添加 VLESS Reality / HTTP2 Reality
- 添加 VLESS、VMess、Trojan 的 WS / H2 / gRPC / HTTPUpgrade 等常见组合
- 添加 Shadowsocks、TUIC、Hysteria2、AnyTLS、SOCKS
- 为单个入站设置下一跳节点 URI，并按入站独立路由
- 更改端口、UUID、密码、域名和 SNI
- 查看 URL 信息
- 使用 RealiTLScanner + RealityChecker 筛选 Reality 目标
- 删除配置

## 安装

1. 下载安装包。
2. 在 NodeGet Dashboard 的扩展管理里上传 zip。
3. 打开 `sing-box 配置管理`。

## 权限

- 列出可见节点 UUID
- 读取节点名称元数据
- 下发并查询 `execute` 任务

## 节点侧

- 需要目标节点具备 `root` 权限或免密 `sudo`
- 支持 systemd 与 Alpine/OpenRC 节点
- Alpine 使用 sing-box 官方 musl 压缩包安装，不再依赖 release `.apk`
- 配置写入 `/etc/sing-box/config.json`
- 下一跳节点支持 SOCKS5、HTTP(S)、Shadowsocks、VLESS、VMess、Trojan、TUIC、Hysteria2 和 AnyTLS URI
- 下一跳 URI 中的凭据会写入 sing-box 配置和 `/etc/nodeget-singbox-panel/nodeget.json`，文件权限为 `0600`
- 添加或删除入站时保留现有配置的其他部分，并备份为 `/etc/sing-box/config.json.bak`
- 已存在的 systemd/OpenRC `sing-box` 服务定义不会被面板覆盖
- “移除面板配置”只删除面板管理的入站、下一跳出站/路由和端口跳跃，不卸载程序或删除其他配置
- 服务名使用 `sing-box`
- VLESS Reality 密钥在添加配置时由面板本地生成
- Reality 目标筛选会在节点 cache 目录下载 RealiTLScanner 和 RealityChecker
- Reality 目标筛选只对用户输入的目标运行，不会自动生成扫描范围

## 开发

```bash
bun install
bun run dev
```

生产包：

```bash
bun run package
```
