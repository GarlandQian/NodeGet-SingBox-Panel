# NodeGet SingBox Panel

NodeGet Dashboard 扩展，用于在节点上安装和管理 sing-box 配置。

## 支持

- 添加 VLESS Reality / HTTP2 Reality
- 按需安装独立 Xray，添加 VLESS + XHTTP + REALITY（HTTP/2、stream-one）
- 添加 VLESS、VMess、Trojan 的 WS / H2 / gRPC / HTTPUpgrade 等常见组合
- 添加 Shadowsocks、TUIC、Hysteria2、AnyTLS、SOCKS
- 为单个入站设置下一跳节点 URI，并按入站独立路由
- 更改端口、UUID、密码、域名和 SNI
- 查看 URI 信息
- 使用 RealiTLScanner + RealityChecker 筛选 Reality 目标
- 安全升级到 sing-box 官方最新稳定版
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
- 升级时校验 GitHub 官方资产 SHA-256，并按官方 1.14 迁移规则转换旧配置后交给新版本检查
- 二进制、配置替换或重启失败时会同时回滚；无法等价转换的条件规则会停止升级
- 配置写入 `/etc/sing-box/config.json`
- 下一跳节点支持 SOCKS5、HTTP(S)、Shadowsocks、VLESS、VMess、Trojan、TUIC、Hysteria2 和 AnyTLS URI
- 域名形式的下一跳使用 sing-box 1.14 `domain_resolver`，默认优先 IPv4 并保留 IPv6 回退
- 下一跳 URI 中的凭据会写入 sing-box 配置和 `/etc/nodeget-singbox-panel/nodeget.json`，文件权限为 `0600`
- 添加或删除入站时保留现有配置的其他部分，并备份为 `/etc/sing-box/config.json.bak`
- 升级前的配置备份为 `/etc/sing-box/config.json.nodeget-pre-upgrade.bak`
- 已存在的 systemd/OpenRC `sing-box` 服务定义不会被面板覆盖
- “移除面板配置”只删除面板管理的入站、下一跳出站/路由和端口跳跃，不卸载程序或删除其他配置
- 服务名使用 `sing-box`
- XHTTP 使用独立的 `nodeget-xray` 服务（systemd / OpenRC），不接管系统已有 Xray
- VLESS Reality 密钥在添加配置时由面板本地生成
- Reality 目标筛选会在节点 cache 目录下载 RealiTLScanner 和 RealityChecker
- Reality 目标筛选只对用户输入的目标运行，不会自动生成扫描范围

## 开发

### XHTTP 首期范围

- 固定服务端基线 [Xray v26.10.21](https://github.com/XTLS/Xray-core/releases/tag/v26.10.21)，客户端联调基线 [Mihomo v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)；不代表兼容所有历史或后续版本
- 协议固定 VLESS + XHTTP + REALITY，HTTP/2、`stream-one`，不设置 Vision flow；默认随机端口 10000–65500，支持 IPv4/IPv6 监听，出站域名优先 IPv4 并保留 IPv6 回退
- 仅支持直连、本机直出；不支持 XHTTP 下一跳、XHTTP 入站的下一跳、CDN/反代、上下行分离、证书 TLS 或 HTTP/3
- 支持添加/编辑/删除、读取、开机自启/启动/停止/重启、独立更新到兼容基线；不会静默跟随 `latest`
- 提供 VLESS URI 和 Mihomo YAML；客户端导入器可能丢失 XHTTP 参数，应核对 `type=xhttp`、`mode=stream-one`、`alpn=h2`、path、Host、SNI、公钥和 Short ID。sing-box 格式会明确拒绝包含 XHTTP 的导出
- 此 Xray 基线的 REALITY 要求新的密钥交换，Mihomo 默认会移除它以兼容旧服务端。导出会显式设置 `reality-opts.support-x25519mlkem768: true`，URI 对应 `support-x25519mlkem768=true`；不可省略，否则可能回落到普通证书校验并连接失败。依据：[Xray REALITY 实现](https://github.com/XTLS/REALITY/blob/83f621788ca8/tls.go)、[Mihomo REALITY 选项](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/adapter/outbound/reality.go)、[URI 转换实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/common/convert/v.go)
- 面板专属二进制 `/usr/local/lib/nodeget-singbox-panel/xray`；配置和元数据分别为 `/etc/nodeget-singbox-panel/xray/config.json`、`nodeget.json`，目录 `0700`、配置 `0600`
- 安装/更新下载官方固定标签的发布包并验证 GitHub 资产 SHA-256，先检查配置，再替换；失败恢复 `.bak` 配置、元数据、二进制及先前服务状态。不会覆盖既有系统 Xray
- 操作使用互斥锁和配置/元数据 SHA-256 检查；检测到并发变更须重新读取。异常断电可能留下 `.lock`，需先确认无操作运行，再人工清理，面板不会强行抢锁
- 两套内核的移除分别执行；部分失败会停止后续操作，需重新读取实际状态。其他配置、程序和服务保留

运行现有检查（包含 XHTTP 隔离部署和回滚模拟）：

```bash
bun run test
bun run build
```

可将真实的固定版本 Xray 交给同一套部署回归脚本，检查生产脚本生成的 `config.stage.json`，覆盖合法/非法配置、旧 `.stage` 路径拒绝、权限、清理、启动/停止、编辑/删除、停止状态升级和回滚。该模式只将系统服务、下载及文件路径隔离到本机临时目录，不替换 Xray 配置检查命令：

```bash
NGP_TEST_XRAY_BIN=/absolute/path/to/xray bun scripts/verify-xhttp.mjs
```

执行结果分为任务回传、子进程退出码和操作后置状态三层校验。面板用独立父 shell 输出与本次请求关联的完成回执，不覆盖子脚本原有的 EXIT 清理/回滚 trap；失败标记、非零退出码、缺失/重复回执、截断输出或不完整成功结果均停止前端状态提交，并要求重新读取。错误详情会脱敏后显示，不在浏览器历史中保存原始配置或凭据。

使用已校验的官方原生二进制运行本机互通测试（只绑定回环地址，不连接线上节点）：

```bash
bun scripts/verify-xhttp-live.mjs /absolute/path/to/xray /absolute/path/to/mihomo
```

该测试运行真实内核，用本地 TLS 1.3/H2 目标完成 REALITY 握手，检查 Mihomo YAML 和 URI 导入、IPv4/IPv6 连接、TCP 和 UDP。仅在临时测试配置中放行回环目的地，生产配置保留 Xray 默认的私网保护；不等同于目标 Linux 节点上的 systemd/OpenRC 部署实测。

```bash
bun install
bun run dev
```

生产包：

```bash
bun run package
```
