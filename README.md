# 简单系统整合暂存区

目标 Firebase 项目：`simplepos-8d23e`

模块：

- `/pos/`：简单POS
- `/simplepay/`：简单支付
- `/affiliate/`：简单联盟营销

## 当前保护状态

统一 Firestore 规则由 `scripts/build-firestore-rules.js` 从三套来源生成。
统一 Functions 位于 `functions/`，三个模块共用同一个 Firestore。
完成模拟器、权限和真实流程测试前不得执行正式部署。

封闭测试进度记录在 `docs/CLOSED_TEST_CHECKLIST.md`。

## 本机配置

将 `public/shared/firebase-config.local.example.js` 复制为
`public/shared/firebase-config.local.js`，再填入新 Firebase Web App 的配置。
该本机文件已被 Git 忽略。
