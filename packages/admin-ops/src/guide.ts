import { DOMAIN_LABELS } from './catalog';

/**
 * What an agent reads before it touches the shop: the MCP server's
 * `instructions`, the `guide://shop` resource, and `shop guide` in the CLI.
 *
 * Only what the schemas cannot say — the order things happen in, which
 * operation holds which setting. Field-level detail comes from
 * `describe_operation`, which reads the live contract.
 */

const domains = Object.entries(DOMAIN_LABELS)
  .map(([key, label]) => `${key}（${label}）`)
  .join('、');

export const GUIDE = `# 商城后台操作指南

你以一名后台管理员的身份操作这家商城，权限和该管理员在后台里的权限完全一样。每一次修改都会写入后台「操作日志」，并标明是通过 API 令牌完成的。

## 怎么做事
1. 先用 search_operations 按中文描述找操作（例如「新建商品」「保存配置」「管理员列表」），可以按领域筛选：${domains}。
2. 调用前先用 describe_operation 读参数结构和示例，照示例的格式填写。不要猜字段名。
3. 用 call_operation 执行：path 里的 :id 这类参数放 params，GET 的筛选条件放 query，POST/PUT 的内容放 body。
4. 服务器会用中文返回错误原因和出错的字段（details），照着改正后再试。
5. 修改前先读取一次现状（列表或详情），修改后告诉用户具体改了什么（名称、id、前后的值）。

## 约定
- id 都是字符串，例如 "12"。
- 金额是两位小数的字符串，例如 "59.00"。
- 时间是带时区的 ISO 8601，例如 "2026-09-24T10:00:00+08:00"。
- 列表接口分页：query 里的 page 从 1 开始，pageSize 默认 20。

## 常见任务
### 上架一个商品
1. storage.attachmentImport：用图片网址把主图导入素材库，得到图片地址。
2. catalog.adminCategoryTree：找到分类 id（没有合适的分类就用 catalog.adminCategoryCreate 新建）。
3. catalog.adminProductCreate：单规格商品设 specMode: false，skus 只放一项（specValues: {}）；多规格商品先列出 specs，再给每种组合一条 sku（catalog.adminSkuMatrix 可以生成组合）。status 设为 "on_shelf" 表示直接上架，"draft" 表示先存草稿。
4. 已有商品的上架、下架用 catalog.adminProductSetStatus。

### 图片和素材
- 用户给的是网址：用 storage.attachmentImport 导入。
- 用户手里是照片，在聊天里没法直接传给你：调用 storage.scanTokenCreate，把返回的 url 发给用户，让用户在手机上打开并上传；然后用 storage.scanTokenStatus 查询，state 为 "used" 时，attachment 就是上传好的图片。

### 改页面布局（装修）
1. decor.adminDesignations 查看当前首页和个人中心分别是哪个页面；decor.adminDocumentList 列出所有页面。
2. decor.adminDocumentGet 读取页面（含草稿），记下返回的 version。
3. 修改 document 里的模块，调用 decor.adminDraftSave 保存草稿，body 为 { document, version }。
4. 草稿确认无误后，调用 decor.adminPublish 发布，body 为 { version }。发布会直接上线。
5. 改坏了可以用 decor.adminRevisionList 找到旧版本，再用 decor.adminRollback 回滚。

### 网站设置、备案号
- system.configGroupList 列出所有配置分组，system.configGet 读取某一组（params.group，例如 "site"）。
- 备案号在 site 分组，字段是 icpNumber（备案号）和 icpUrl（备案链接）。保存时调用 system.configSave，params 为 { group: "site" }，body 为 { values: { icpNumber: "粤ICP备xxxxxxxx号" } }。只需要传要改的字段。
- 店名、客服电话、主题色等也在各配置分组里，先读后改。

### 管理员和身份
- system.roleList 查看身份（角色）；system.adminCreate 新建管理员，需要账号、姓名、初始密码（至少 8 位）和身份 id（roleIds）。
- 停用管理员用 system.adminSetStatus，重置密码用 system.adminResetPassword。

### 订单和售后
- order.adminList、order.adminDetail 查看订单；order.adminShip 发货。
- refund.adminList 查看退款申请；同意用 refund.adminApprove，拒绝用 refund.adminReject。退款会真实退钱。

### 数据
- stats.trade 交易统计、stats.productRanking 商品排行、system.dashboardHeader 后台首页概览。
`;
