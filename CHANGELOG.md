# 更新日志

本文件记录 dsh-key-panel 的用户可见变更。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 1.0.1 — 2026-09-27

- 修复设置面板中「显示」「保存」等操作偶发弹出 "Receiver must be an instance of class KeyPanelGateway" 报错的问题——操作实际已生效，报错为误报，现已消除。

## 1.0.0 — 2026-09-24

- 首个正式版本：密钥集中存储，以 `$DSH_*` 形式注入助手的 shell 环境，助手使用密钥但不接触原文。
- 设置面板支持密钥管理、按平台/账号分组，以及只读 / 可写 / 可编辑三种访问模式。
