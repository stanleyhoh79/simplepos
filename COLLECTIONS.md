# Firestore 集合分区

统一项目：`simplepos-8d23e`

## 简单POS

- `branches`
- `users`
- `products`
- `sales`
- `stockAdjustments`
- `integrationJobs`
- `settings`
- `auditLogs`

POS 员工文档继续以授权邮箱作为 `users` 文档 ID，分行权限由
`branchId` 控制。

## 简单支付

- `wallets`
- `merchants`
- `merchantOrders`
- `paymentIntents`
- `merchantRefundIntents`
- `rechargeRequests`
- `withdrawRequests`
- `refundRequests`
- `settlementRequests`
- `transactions`
- `systemConfig`
- `adminUsers`
- `kycRequests`
- `supportTickets`
- `marketingItems`
- `payAuditLogs`

原 SimplePay 的 `auditLogs` 在统一项目内改为 `payAuditLogs`，避免与
POS 审计记录冲突。

## 简单联盟营销

联盟模块继续使用现有 `amsystem` 前缀，包括：

- `amsystem`
- `amsystemUsers`
- `amsystemOrders`
- `amsystemRewards`
- `amsystemWithdraws`
- `amsystemPointLogs`
- `amsystemRepeatCreditLogs`
- `amsystemAdminLogs`
- `amsystemInviteCodes`
- `amsystemReferrals`
- `amsystemExternalOrders`
- `amsystemReversalCases`
- `amsystemIntegrationCommands`

## 合并原则

- 所有模块共用 Firebase Authentication，同一个 Google 账号只登录一次。
- Firestore 集合按业务模块隔离，规则分别判断角色与资料归属。
- POS 分行数据仍以 `branchId` 隔离，不因项目合并而互通给普通员工。
- 跨模块订单使用稳定的 POS 订单 ID 和整合任务 ID 关联。
