# App Store Connect：上传之后，怎样真正完成提审

实测：2026-09-08，已登录的真实Chrome，macOS与iOS更新版本；huashu-chrome本机1.1.1。接口与界面可能变化，使用前对照当前network/snapshot。这里不保存账号、App ID、构建ID或审核联系人。

## 适用范围与授权

用户要求「直接提交审核」，且指定App与版本范围时，完成必要核对后可以执行最终提交，不必再次索要同一授权。仅要求检查或准备时，做到可审阅结果，不自行提交。提审授权不自动包含修改价格、停止老订阅续费、接受新的开发者协议。

本节从已上传构建开始。archive、签名、上传使用项目发布流程/Xcode；原生应用与设备测试走相应工具，不把浏览器经验当成签名或测试替代品。

## 先对齐四种ID

- appId：产品，通常是数字。
- versionId：App Store版本条目，通常是UUID；versionString是1.8.0之类的展示版本。
- buildId：上传构建，通常是UUID；build.attributes.version是构建号。结合preReleaseVersion确认展示版本，不能凭「build2」跨App选择。
- submissionId：一次审核提交，通常是UUID；可包含App版本和内购等多个项目。

「已上传且VALID」仅说明Apple处理完包；不保证版本条目存在、构建已关联，或已提交审核。同一展示版本可能有多个VALID构建，选择前匹配已验收源码和构建回执。不要把后台现成的另一个build默认当成本次修复。

每条工作线新开带label的tab，保存返回tabId，之后每个调用显式传tabId。已有其他工作线提交了正确版本，核实并保留，不撤回重交。单个动作回执误跟进到另一条线新开的无关tab，本轮发生过一次；以tabs.list和原tab的当前URL重新确认归属，不沿无关页面继续。

## 可复用的读写入口

以下是本轮已验证路径，所有尖括号都是占位符。先看现场请求或资源的links，再带页面登录态fetch；不要手工复制Cookie或伪造签名。

```text
GET /iris/v1/apps/<appId>?include=displayableVersions&limit[displayableVersions]=20
GET /iris/v1/appStoreVersions/<versionId>?include=appStoreVersionLocalizations,build,appStoreReviewDetail
GET /iris/v1/builds?filter[app]=<appId>&filter[preReleaseVersion.platform]=IOS&filter[isAppStoreCandidate]=true&filter[processingState]=VALID&include=preReleaseVersion&limit=10
GET /iris/v1/apps/<appId>/reviewSubmissions?include=appStoreVersionForReview,items&limit=10
GET /iris/v1/reviewSubmissions/<submissionId>?include=appStoreVersionForReview,items
```

collection和嵌套relationship都检查meta.paging.total/limit与links.next，不能默认前10条就是全部。大响应提高maxBody或用稀疏字段；先在工具编排层解析，只向模型输出ID、版本、状态、时间等所需字段，不整段倾倒联系人和无关元数据。

已验证的草稿修改方式：

```text
PATCH /iris/v1/appStoreVersionLocalizations/<localizationId>
{"data":{"type":"appStoreVersionLocalizations","id":"<localizationId>","attributes":{"whatsNew":"<更新说明>"}}}

PATCH /iris/v1/appStoreReviewDetails/<reviewDetailId>
{"data":{"type":"appStoreReviewDetails","id":"<reviewDetailId>","attributes":{"notes":"<审核备注>"}}}

PATCH /iris/v1/appStoreVersions/<versionId>/relationships/build
{"data":{"type":"builds","id":"<buildId>"}}
```

前两项本轮返回200，关联构建返回204。写完GET同一资源验证精确值；UI若仍显示旧内容，重新加载草稿后再操作，避免用旧表单保存覆盖新值。不要为重复按钮硬编码nth：本轮加密弹层与背景各有「保存」，优先定位弹层；只在当前snapshot证实顺序后用nth。

新建版本用UI：已上架版本左侧「添加iOS App」或平台旁的「+」→版本号→创建。新版本会继承多语言描述和截图，但本轮Pro的五种语言whatsNew都为空；不能只填主语言后假设其它语言齐全。中文可沿用已批准稿，其余按真实功能翻译并检查。

## 最后两次点击是不同阶段

从现场状态继续：PREPARE_FOR_SUBMISSION才需要「添加以供审核」；READY_FOR_REVIEW直接打开已有草稿；已经WAITING_FOR_REVIEW/IN_REVIEW则核对归属后记录状态，不重新提交。

1. 版本、构建、更新说明、审核信息就绪且没有未保存改动，点击「添加以供审核」。已有草稿时，会先出现草稿选择菜单；选需要与之合并的草稿，不误建第二份。
2. 等异步出现「草稿提交」面板。核对App版本、build，以及内购等项目清单。「可供审核」/READY_FOR_REVIEW表示已入草稿，还没进Apple队列。
3. 用户已授权最终提交时，单独调用act点击「提交以供审核」，显式allowSensitive:true，让回执清楚记录这次动作。
4. 「正在提交」仍是中间态。读reviewSubmission.state和submittedDate，再核对对应appStoreVersion状态；进入WAITING_FOR_REVIEW才报告「正在等待审核」。如果先看到IN_REVIEW或更后状态，按实际状态报告。

不把整条链路写成一个跨异步弹层的盲点脚本。能够预测的填表操作可批量；最终提交与结果验证分开。页面语言不同，以现场文案为准。

回执至少存appId、versionId/versionString、buildId/build号、submissionId、审核项目清单、服务端submittedDate、验证时间、releaseType。截图辅助证明页面；不能用截图代替构建和提交归属核对。保留既有发布方式、评分设置，除非用户要求改变。

## 超时、后台冻结与旧状态

- 本轮部分后台页仅有页眉/页脚、3—16个元素，或一直「正在提交」。先给异步加载机会，查看当前URL；需要时在已有电脑操控授权内切前台并说明。仅wait idle不能保证React已完成业务渲染。
- act可能报告「没有可归因变化」，但同一返回快照已经出现加密对话框。以实际后置状态决定下一步，别再点背景的「管理」。
- 单tab调用32秒超时，而tabs.list和doctor正常：可能是该页面卡住，不能宣布整套工具被锁。先用其它正常tab同源只读查询提交状态，再新开目标页恢复操作。未确认服务端未受理前，不重放最终提交。
- 本轮内购详情GET曾返回MISSING_METADATA，而网页已有完整截图并显示「准备提交」。带init.cache:"no-store"重新读取、检查关联截图assetDeliveryState和审核草稿的实际校验；不能仅凭一份旧响应判死，也不能直接认定旧值一定是缓存。
- 已授权动作被act的敏感词保护暂停，可在核对目标后用allowSensitive:true。真正的宿主自动审批拒绝、登录/验证码/系统权限障碍不能靠换工具绕过；如实报告拒绝动作与原因。不要把另一个会话的工具限制推断为本会话也不可用。

## 出口合规：判断实际构建，不看文件夹名

「缺少出口合规证明」通常可从build旁「管理」打开问卷。先核实际加密使用（含已链接第三方依赖），再按当前Apple问题回答，不把所有App一律填同一答案。

本轮遇到的误判：仓库内有带AES/RSA声明的广告SDK目录，但Xcode链接配置、Podfile.lock、归档App的Frameworks、otool依赖与相关符号均没有它。存在SDK源码/头文件不证明它进入待审包；反过来，只查自有Swift代码也不能排除SDK使用加密。符号搜索是辅助证据，不是完整加密分类证明。

仅使用Apple系统提供的加密（如URLSession HTTPS）通常不需上传加密文档；根据实际构建判断后可完成这一已授权提审的技术元数据步骤。若确有未知或非豁免算法，继续核依赖官方说明，无法判定时指出具体未知项，别猜。不得代为接受新法律协议。

权威说明：[加密出口合规](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)、[加密文档分类](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)。规则会更新，作分类时读当前文档。

## 内购必须与版本一起核对

本轮实证路径：

```text
GET /iris/v1/apps/<appId>/inAppPurchasesV2
GET /iris/v2/inAppPurchases/<iapId>?include=inAppPurchaseLocalizations,appStoreReviewScreenshot,iapPriceSchedule,inAppPurchaseAvailability
```

collection叫inAppPurchasesV2，单资源却是v2/inAppPurchases，type为inAppPurchases。猜`/iris/v1/inAppPurchasesV2/<iapId>`会404；跟返回links.self/related。

- 确认productId与代码完全一致、产品类型、基准地区/币种、价格、销售地区、本地化、审核图、入口说明。截图应是待审功能的真实截图，assetDeliveryState=COMPLETE才表示上传处理完成。
- 首个非消耗型内购本轮必须随新App版本提交。可以先从内购页「添加以供审核」，再把App版本加到同一草稿。最终面板同时列出版本/build与内购后再提交。
- 提交后除App版本外，还读内购state=WAITING_FOR_REVIEW、reviewSubmission项目数量及归属。只提交App版本可能漏掉新买断。
- 付费模式变化时同步检查旧商店描述：不能更新说明说「整理永久免费」，描述仍说「会员才可无限整理」。以代码实际展示的商品与后台实际销售状态写文案，不凭旧待办猜。
- 「App内不展示周订阅」「后台停止销售」「现有订阅停止续费」是三种事实。本轮Apple下架确认框明确会停止自动续期，并涉及剩余账期服务/退款承诺；旧文档说「老用户继续续费」被证伪。若用户只授权提审，可以保留现有订阅并改准文案；不要把下架当成必需清理动作，不代替用户做新的付费决定。

## iCloud功能的发布依赖

先确认该版本实际使用CloudKit且需要哪些模型；仅写「iCloud同步」也可能使用其它iCloud能力，不自动触发schema部署。确有CloudKit模型时，不能只看archive/upload成功，检查Production是否具备所需字段；已齐全则不重建。Development只有Users且Production也缺所需模型时，「没有待部署变更」不表示准备完成。

继续查`learnings({domain:"icloud.developer.apple.com"})`，那里记录了模型初始化、部署和生产读回的边界。schema成功不等于已完成两设备端到端同步验收。

## 文件取证

本轮MCP screenshot+savePath已真实落盘，旧「screenshot永远不写盘」经验过时。默认实际为JPEG，即使路径叫.png也不会转成PNG；需原尺寸PNG用full:true，保存后验文件存在、大小和真实格式。

单页文本fetch的savePath本轮未落盘：解析返回文本后由宿主写文件。二进制fetch、MCP分页fetch、download和screenshot是不同处理分支，别相互推断。CLI与MCP也要分别验证；完整JSON解析失败时先查maxBody截断，别手工补括号造回执。
