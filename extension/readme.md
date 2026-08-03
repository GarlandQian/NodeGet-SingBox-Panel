# NodeGet SingBox Panel

用于在 NodeGet Dashboard 中安装和管理 sing-box 配置。

## 支持

- 添加 VLESS Reality / HTTP2 Reality
- 添加 VLESS、VMess、Trojan 的 WS / H2 / gRPC / HTTPUpgrade 等常见组合
- 添加 Shadowsocks、TUIC、Hysteria2、AnyTLS、SOCKS
- 更改端口、UUID、密码、域名和 SNI
- 查看 URL 信息
- 使用 RealiTLScanner + RealityChecker 筛选 Reality 目标
- 删除配置

## 节点侧

- 需要目标节点具备 `root` 权限或免密 `sudo`
- 支持 systemd 与 Alpine/OpenRC 节点
- Alpine 使用 sing-box 官方 musl 压缩包安装，不再依赖 release `.apk`
- 配置写入 `/etc/sing-box/config.json`
- 添加或删除入站时保留现有配置的其他部分，并备份为 `/etc/sing-box/config.json.bak`
- 已存在的 systemd/OpenRC `sing-box` 服务定义不会被面板覆盖
- “移除面板配置”只删除面板管理的入站和端口跳跃，不卸载程序或删除其他配置
- 服务名使用 `sing-box`
- VLESS Reality 密钥在添加配置时由面板本地生成
- Reality 目标筛选会在节点 cache 目录下载 RealiTLScanner 和 RealityChecker
- Reality 目标筛选只对用户输入的目标运行，不会自动生成扫描范围
