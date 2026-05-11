# NodeGet SingBox Panel

NodeGet Dashboard 扩展，用于在节点上安装和管理 sing-box 配置。

## 支持

- 添加 VLESS Reality / HTTP2 Reality
- 添加 VLESS、VMess、Trojan 的 WS / H2 / gRPC / HTTPUpgrade 等常见组合
- 添加 Shadowsocks、TUIC、Hysteria2、AnyTLS、SOCKS
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
- 配置写入 `/etc/sing-box/config.json`
- 服务名使用 `sing-box`
- VLESS Reality 公钥在添加配置时由节点生成
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
