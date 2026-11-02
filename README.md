# PetraDev · Live2D 桌面宠物（改版）

在开源项目 **[Petra](https://github.com/Wumiu/Petra)**（Live2D 桌面宠物，Tauri 2）基础上做的精简与交互改造版本。

目标不是增加功能，而是让它在高分屏上真正好用。

> 上游原始说明保留在 [README.upstream.md](./README.upstream.md)。

## 改了什么

### 1. 产品收敛（-25,213 行）

移除语音（TTS/ASR）、小游戏、抽卡、反馈、官网入口等非核心模块，
删掉 91 个文件与约 6.4 MB 素材，把体积和依赖降下来。

### 2. 交互重做

- 待机时收缩至右下角，**不再遮挡任务栏**
- 支持自由拖拽，模型可移出屏幕，松手自动回弹
- 新增探头、贴边陪伴效果
- 拖动过程中只预览、松手才重定位，消除窗口抖动与闪烁
- 适配 2048×1152 / 200% 缩放

### 3. 模型与渲染

- 将原 PSD 立绘替换为真实 Live2D 模型（Cubism 2 / 4）
- 修复首帧大纹理只渲染半身（预热 `model.update(0)` 后再显示）
- 修复视线跟随参数被内置动作覆盖（参数写入移到 `coreModel.update()` 之前）

### 4. 与上游区分

二进制改名 `PetraDev.exe`，独立签名、独立快捷方式；
`identifier` 保持不变（避免用户数据目录重置）。

## AI 协作说明

本项目**约 90% 的代码由 AI 编程工具生成**。我负责的部分是：

- **产品定义**：确定「轻量陪伴工具」的定位，决定砍掉哪些模块
- **交互标准**：定义待机收缩比例、拖拽边界、回弹行为等验收指标
- **缺陷发现**：从运行现象定位问题（如「启动只出半身」），提交给 AI 并跟踪修复
- **验收**：逐项确认交互与渲染效果是否符合预期

代码实现由 AI 完成，方案取舍与验收由我负责。

## 技术栈

| 层 | 选型 |
|---|---|
| 应用外壳 | Tauri 2.11 |
| 语言（后端） | Rust（Edition 2021） |
| 语言（前端） | TypeScript 5.7 |
| 渲染 | PIXI.js 6.5 |
| Live2D | pixi-live2d-display 0.4 |
| 构建 | Vite 6.1 + tauri-cli |
| 平台 API | windows-rs 0.58 |

## 构建

```powershell
npm install
npm run tauri build -- --no-bundle
# 产物：src-tauri/target/release/PetraDev.exe
```

## 致谢

上游项目 [Petra](https://github.com/Wumiu/Petra)，版权归原作者所有。
本仓库仅作学习与自用。
