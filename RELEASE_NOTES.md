## OpController v0.1.15

本次更新修复 Windows 环境下升级流程可能继续提示新版本、点击更新又被 `plugin:event|listen` ACL 拦截的问题。

更新安装现在会在进度事件监听不可用时自动降级为无详细进度安装，不会再因为进度监听失败而中断下载安装。

发布流水线也会强制清理旧的 Tauri 桌面壳产物，避免 Windows runner 复用缓存中的旧安装包内容。
